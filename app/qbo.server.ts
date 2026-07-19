import crypto from "node:crypto";
import prisma from "./db.server";

const AUTHORIZATION_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPE = "com.intuit.quickbooks.accounting";

// Refresh a little before the access token actually expires so a request
// never races an in-flight expiry.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Prefer SHOPIFY_APP_URL: the Shopify CLI injects it fresh on every
// `shopify app dev` restart to match whatever tunnel URL it just created,
// so it never goes stale the way a hardcoded QBO_REDIRECT_URI would across
// tunnel restarts. QBO_REDIRECT_URI remains a supported override for
// deployments (production, a stable staging domain) where it may differ.
function redirectUri(): string {
  return process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/app/qbo/callback`
    : env("QBO_REDIRECT_URI");
}

function basicAuthHeader(): string {
  const credentials = `${env("QBO_CLIENT_ID")}:${env("QBO_CLIENT_SECRET")}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function signState(shop: string): string {
  const payload = Buffer.from(
    JSON.stringify({ shop, nonce: crypto.randomBytes(16).toString("hex") }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", env("QBO_CLIENT_SECRET"))
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

export function verifyState(state: string): string {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new Error("Malformed state parameter");
  }

  const expected = crypto
    .createHmac("sha256", env("QBO_CLIENT_SECRET"))
    .update(payload)
    .digest("hex");

  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid state parameter");
  }

  const { shop } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof shop !== "string" || !shop) {
    throw new Error("Invalid state payload");
  }
  return shop;
}

export function buildAuthorizationUrl(shop: string): string {
  const params = new URLSearchParams({
    client_id: env("QBO_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    state: signState(shop),
  });
  return `${AUTHORIZATION_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `QuickBooks token request failed: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

export async function exchangeCodeForTokens(code: string) {
  return requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
  );
}

async function refreshTokens(refreshToken: string) {
  return requestTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

function tokenExpiryDates(tokens: TokenResponse) {
  const now = Date.now();
  return {
    accessTokenExpires: new Date(now + tokens.expires_in * 1000),
    refreshTokenExpires: new Date(now + tokens.x_refresh_token_expires_in * 1000),
  };
}

export async function saveConnection(
  shop: string,
  realmId: string,
  tokens: TokenResponse,
) {
  const { accessTokenExpires, refreshTokenExpires } = tokenExpiryDates(tokens);

  return prisma.quickBooksConnection.upsert({
    where: { shop },
    create: {
      shop,
      realmId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpires,
      refreshTokenExpires,
    },
    update: {
      realmId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpires,
      refreshTokenExpires,
    },
  });
}

export async function getConnection(shop: string) {
  return prisma.quickBooksConnection.findUnique({ where: { shop } });
}

/**
 * Returns a connection with a guaranteed-valid access token, refreshing it
 * first if it's expired or about to expire. Returns null if there's no
 * connection, or if the refresh token itself is no longer valid — in the
 * latter case the stale connection is deleted so the UI shows "disconnected"
 * rather than a connection that looks fine but can't actually be used.
 */
export async function getValidConnection(shop: string) {
  const connection = await getConnection(shop);
  if (!connection) return null;

  if (connection.accessTokenExpires.getTime() - REFRESH_SKEW_MS > Date.now()) {
    return connection;
  }

  try {
    const tokens = await refreshTokens(connection.refreshToken);
    return saveConnection(shop, connection.realmId, tokens);
  } catch {
    await disconnectShop(shop);
    return null;
  }
}

export async function disconnectShop(shop: string) {
  const connection = await getConnection(shop);
  if (!connection) return;

  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: basicAuthHeader(),
      },
      body: JSON.stringify({ token: connection.refreshToken }),
    });
  } catch {
    // Best-effort: even if Intuit's revoke call fails (e.g. token already
    // invalid), still drop our local record so the shop can reconnect.
  }

  await prisma.quickBooksConnection.delete({ where: { shop } });
}

// --- Query API (read-only) ---------------------------------------------

const QUERY_API_MAX_RESULTS = 1000;
const QUERY_API_MAX_RETRIES = 3;
const TRANSACTION_WINDOW_DAYS = 60;

function apiBaseUrl(): string {
  return process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function transactionWindowStart(): string {
  const date = new Date();
  date.setDate(date.getDate() - TRANSACTION_WINDOW_DAYS);
  return date.toISOString().slice(0, 10); // QBO date literals are 'YYYY-MM-DD'
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempt = 1,
): Promise<Response> {
  const response = await fetch(url, init);

  if (
    (response.status === 429 || response.status === 503) &&
    attempt <= QUERY_API_MAX_RETRIES
  ) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : attempt * 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchWithRetry(url, init, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();
    // The route layer (safe() in app.quickbooks.tsx) swallows this error down
    // to a generic "unable to load" message for the UI, so the only place
    // the actual QBO fault (status, decoded query, response body) is visible
    // is here in the server console — log it before throwing.
    console.error(
      `QuickBooks API request failed: ${response.status} ${response.statusText}\n` +
        `URL: ${decodeURIComponent(url)}\n` +
        `Body: ${body}`,
    );
    throw new Error(`QuickBooks API request failed: ${response.status} ${body}`);
  }

  return response;
}

/**
 * Runs a QBO Query API SELECT against one entity, transparently paginating
 * via STARTPOSITION/MAXRESULTS (QBO caps a single page at 1000 rows) until a
 * page comes back smaller than the page size.
 */
async function queryAll<T>(
  accessToken: string,
  realmId: string,
  entity: string,
  select: string,
  where?: string,
): Promise<T[]> {
  const results: T[] = [];
  let startPosition = 1;

  for (;;) {
    const query =
      `SELECT ${select} FROM ${entity}` +
      (where ? ` WHERE ${where}` : "") +
      ` STARTPOSITION ${startPosition} MAXRESULTS ${QUERY_API_MAX_RESULTS}`;

    const url = `${apiBaseUrl()}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
    const response = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const body = await response.json();
    const page: T[] = body.QueryResponse?.[entity] ?? [];
    results.push(...page);

    if (page.length < QUERY_API_MAX_RESULTS) break;
    startPosition += QUERY_API_MAX_RESULTS;
  }

  return results;
}

interface Ref {
  value: string;
  name?: string;
}

export interface SalesReceiptRow {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  TotalAmt: number;
  CustomerRef?: Ref;
  PaymentMethodRef?: Ref;
}

export interface InvoiceRow {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  TotalAmt: number;
  Balance?: number;
  CustomerRef?: Ref;
}

export interface LinkedTxn {
  TxnId: string;
  TxnType: string;
}

export interface PaymentRow {
  Id: string;
  // Payment has no DocNumber field — PaymentRefNum is QBO's equivalent
  // reference number (e.g. a check number) and is what the UI shows in its
  // "doc number" column for payments.
  PaymentRefNum?: string;
  TxnDate: string;
  TotalAmt: number;
  CustomerRef?: Ref;
  LinkedTxn?: LinkedTxn[];
}

export interface DepositLine {
  Amount: number;
  // LinkedTxn sits on the line itself (sibling of DepositLineDetail), not
  // nested inside it — it's how a deposit line traces back to the specific
  // Payment/SalesReceipt that was swept into this deposit from Undeposited
  // Funds. Comes back automatically now that fetchDeposits uses SELECT *.
  LinkedTxn?: LinkedTxn[];
  DepositLineDetail?: { Entity?: Ref };
}

export interface DepositRow {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  Line?: DepositLine[];
}

export interface CustomerRow {
  Id: string;
  DisplayName: string;
  PrimaryEmailAddr?: { Address: string };
}

export function fetchSalesReceipts(accessToken: string, realmId: string) {
  // Same class of fault as fetchDeposits: QBO's Query API rejects
  // "PaymentMethodRef" as an explicit SELECT column ("Property
  // PaymentMethodRef not found for Entity SalesReceipt", code 4001), even
  // though it's a real field on the entity. SELECT * sidesteps the
  // column allowlist and returns it (and everything else) anyway.
  return queryAll<SalesReceiptRow>(
    accessToken,
    realmId,
    "SalesReceipt",
    "*",
    `TxnDate >= '${transactionWindowStart()}'`,
  );
}

export function fetchInvoices(accessToken: string, realmId: string) {
  return queryAll<InvoiceRow>(
    accessToken,
    realmId,
    "Invoice",
    "Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef",
    `TxnDate >= '${transactionWindowStart()}'`,
  );
}

export function fetchPayments(accessToken: string, realmId: string) {
  return queryAll<PaymentRow>(
    accessToken,
    realmId,
    "Payment",
    "Id, PaymentRefNum, TxnDate, TotalAmt, CustomerRef, LinkedTxn",
    `TxnDate >= '${transactionWindowStart()}'`,
  );
}

export function fetchDeposits(accessToken: string, realmId: string) {
  // QBO's Query API rejects "Line" as an explicit SELECT column ("Property
  // Line not found for Entity Deposit", code 4001) — line-item detail is
  // only ever returned via SELECT *, never by naming it as a column. Every
  // other fetch* here can list exact columns; this one can't.
  return queryAll<DepositRow>(
    accessToken,
    realmId,
    "Deposit",
    "*",
    `TxnDate >= '${transactionWindowStart()}'`,
  );
}

// Customers aren't transactions, so there's no TxnDate to scope by — this
// pulls the full customer list (still paginated the same way).
export function fetchCustomers(accessToken: string, realmId: string) {
  return queryAll<CustomerRow>(
    accessToken,
    realmId,
    "Customer",
    "Id, DisplayName, PrimaryEmailAddr",
  );
}
