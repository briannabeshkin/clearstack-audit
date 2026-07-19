import { useState } from "react";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate, BILLING_IS_TEST } from "../shopify.server";
import {
  FULL_AUDIT_INTRO_PRICE,
  FULL_AUDIT_PLAN_INTRO,
  FULL_AUDIT_PLAN_REGULAR,
  FULL_AUDIT_REGULAR_PRICE,
  type CurrentPlan,
} from "../billing-shared";
import { getCurrentPlan, recordPurchaseIfNew } from "../billing.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  fetchRecentOrders,
  fetchRecentPayouts,
  type PayoutRow,
} from "../shopify-data.server";
import {
  fetchDeposits,
  fetchInvoices,
  fetchPayments,
  fetchSalesReceipts,
  getValidConnection,
} from "../qbo.server";
import {
  reconcile,
  revenueFindingImpact,
  settlementFindingImpact,
  type RevenueFinding,
  type SettlementFinding,
} from "../reconcile";
import {
  describeRevenueFinding,
  describeSettlementFinding,
  formatMoney,
  type FindingDisplay,
} from "../reconcile-copy";

interface Fetched<T> {
  rows: T[];
  error: boolean;
}

// IMPORTANT: every external fetch (Shopify GraphQL, QuickBooks REST) must
// be wrapped in safe()/safeValue() at the moment it's kicked off, not just
// awaited inside a later try/catch. Kicking a promise off early for
// concurrency, then only awaiting it after *other* awaits happen first
// (e.g. another fetch's own await), leaves a window where the promise can
// reject before anything is listening — Node treats that as an unhandled
// rejection and can crash the whole process, even though a try/catch
// exists further down the function. This actually happened: an
// unhandled-scope GraphQL error from fetchRecentPayouts crashed the dev
// server despite a try/catch around its later `await`, because
// fetchRecentOrders' own await ran first and gave the rejection room to be
// "unhandled" before the payouts try/catch ever executed. Catching inside
// the same async call, before the promise is ever handed back to the
// caller, closes that gap — the promises these return can never reject.
async function safe<T>(fn: () => Promise<T[]>): Promise<Fetched<T>> {
  try {
    return { rows: await fn(), error: false };
  } catch {
    return { rows: [], error: true };
  }
}

interface FetchedValue<T> {
  value: T;
  error: boolean;
}

// Same as safe(), for fetches that don't return an array (e.g. payouts,
// which come back as { payouts, hasPayoutsAccount }).
async function safeValue<T>(fn: () => Promise<T>, fallback: T): Promise<FetchedValue<T>> {
  try {
    return { value: await fn(), error: false };
  } catch {
    return { value: fallback, error: true };
  }
}

const REPORT_CURRENCY = "USD";

// The purchase is a one-time unlock, not a per-run charge — the merchant
// pays once and every future reload of this page shows the full itemized
// report from then on, rather than being charged again each time the data
// is re-pulled.
//
// Which plan gets requested is decided fresh here (not passed in from the
// client), based on the current sold count — the same lookup the loader
// uses to render the CTA copy. This is the actual charge, so it has to be
// authoritative rather than trusting whatever price the page happened to
// be showing when the merchant clicked.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);

  let plan: CurrentPlan;
  try {
    plan = await getCurrentPlan();
  } catch (error) {
    // Most likely cause: the AuditPurchase table/Prisma client isn't in
    // sync with schema.prisma yet (needs `npx prisma generate` +
    // `npx prisma migrate dev` run locally) — getCurrentPlan() counts rows
    // in that table to decide intro vs. regular pricing.
    console.error("[billing action] getCurrentPlan() failed — plan lookup never reached Shopify:", {
      shop: session.shop,
      error,
    });
    throw error;
  }

  try {
    await billing.request({
      plan: plan.name,
      isTest: BILLING_IS_TEST,
      returnUrl: `${process.env.SHOPIFY_APP_URL ?? ""}/app?shop=${encodeURIComponent(session.shop)}`,
    });
    // billing.request() always throws on success too — a Response carrying
    // the redirect to Shopify's confirmation page (or, for this embedded
    // XHR call, a 401 with App Bridge redirect headers). This line never
    // actually runs; the throw is caught below and re-raised untouched.
    return null;
  } catch (error) {
    if (error instanceof Response) {
      // The expected success path — not a failure. Let it propagate so
      // React Router / App Bridge can turn it into the redirect.
      throw error;
    }

    // A genuine failure requesting billing from Shopify. Common causes:
    // `plan.name` doesn't match a key in the `billing` config in
    // shopify.server.ts (e.g. the dev server wasn't restarted after that
    // config changed), or Shopify's appPurchaseOneTimeCreate mutation
    // returned userErrors (bad returnUrl, invalid amount, shop can't be
    // charged, etc.) — those show up as a BillingError with `errorData`.
    const details: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      shop: session.shop,
      requestedPlan: plan.name,
      isTest: BILLING_IS_TEST,
      returnUrl: `${process.env.SHOPIFY_APP_URL ?? ""}/app?shop=${encodeURIComponent(session.shop)}`,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    if (error && typeof error === "object" && "errorData" in error) {
      details.errorData = (error as { errorData: unknown }).errorData;
    }

    // The CLI's log panel has been swallowing/scrolling past plain
    // console.error output for this, so write it straight to a file in the
    // project root instead — no terminal scrollback needed, just read
    // billing-debug.log directly. Best-effort: if the write itself fails
    // for some reason, fall back to console.error rather than lose the
    // failure entirely, and never let logging itself break the request.
    const line = `${JSON.stringify(details)}\n`;
    try {
      appendFileSync(join(process.cwd(), "billing-debug.log"), line);
    } catch {
      console.error("[billing action] billing.request() failed:", details);
    }

    throw error;
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const connection = await getValidConnection(session.shop);

  if (!connection) {
    return { connected: false as const };
  }

  const { accessToken, realmId } = connection;

  // Kick every fetch off concurrently, each wrapped in safe()/safeValue()
  // immediately — see the comment on safe() above for why that has to
  // happen right here, at creation, rather than in a try/catch around a
  // later await. One failing source degrades its own section of the
  // report instead of taking down the whole request.
  const ordersRequest = safe(() => fetchRecentOrders(admin.graphql));
  const payoutsRequest = safeValue(() => fetchRecentPayouts(admin.graphql), {
    payouts: [] as PayoutRow[],
    hasPayoutsAccount: false,
  });
  const salesReceiptsRequest = safe(() => fetchSalesReceipts(accessToken, realmId));
  const invoicesRequest = safe(() => fetchInvoices(accessToken, realmId));
  const paymentsRequest = safe(() => fetchPayments(accessToken, realmId));
  const depositsRequest = safe(() => fetchDeposits(accessToken, realmId));

  const [ordersResult, payoutsResult, salesReceipts, invoices, payments, deposits] =
    await Promise.all([
      ordersRequest,
      payoutsRequest,
      salesReceiptsRequest,
      invoicesRequest,
      paymentsRequest,
      depositsRequest,
    ]);

  const { payouts, hasPayoutsAccount } = payoutsResult.value;

  const dataErrors = {
    orders: ordersResult.error,
    payouts: payoutsResult.error,
    salesReceipts: salesReceipts.error,
    invoices: invoices.error,
    payments: payments.error,
    deposits: deposits.error,
  };
  const dataIncomplete = Object.values(dataErrors).some(Boolean);

  const { revenue, settlement } = reconcile({
    orders: ordersResult.rows,
    payouts,
    salesReceipts: salesReceipts.rows,
    invoices: invoices.rows,
    payments: payments.rows,
    deposits: deposits.rows,
  });

  const totalImpact =
    revenue.findings.reduce((sum, finding) => sum + revenueFindingImpact(finding), 0) +
    settlement.reduce((sum, finding) => sum + settlementFindingImpact(finding), 0);

  const missingOrders = revenue.findings.filter((finding) => finding.type === "missing-order");
  const duplicatesAndConflicts = revenue.findings.filter(
    (finding) => finding.type === "duplicate" || finding.type === "reference-conflict",
  );
  const varianceOrders = revenue.findings.filter((finding) => finding.type === "matched-variance");
  const reviewOrders = revenue.findings.filter((finding) => finding.type === "matched-fuzzy");
  const matchedOrderCount = revenue.findings.filter((finding) => finding.type === "matched").length;

  const payoutMismatches = settlement.filter(
    (finding) => finding.type === "not-deposited" || finding.type === "amount-mismatch",
  );
  const unexplainedDeposits = settlement.filter((finding) => finding.type === "unexplained-deposit");
  const matchedPayoutCount = settlement.filter((finding) => finding.type === "matched").length;

  const issueCount = missingOrders.length + duplicatesAndConflicts.length + payoutMismatches.length;

  // A clean audit costs the merchant nothing — there's nothing to sell if
  // we didn't find anything wrong. Skip billing entirely: no plan lookup,
  // no billing.check() call, no charge, no CTA. This has to be decided
  // before we touch billing at all, not just hidden in the UI afterward.
  if (issueCount === 0) {
    return {
      connected: true as const,
      clean: true as const,
      matchedOrderCount,
      matchedPayoutCount,
      hasPayoutsAccount,
      dataErrors,
      dataIncomplete,
    };
  }

  const breakdown = {
    missingOrders: missingOrders.length,
    duplicatesAndConflicts: duplicatesAndConflicts.length,
    payoutMismatches: payoutMismatches.length,
  };

  const [currentPlan, { hasActivePayment, oneTimePurchases }] = await Promise.all([
    getCurrentPlan(),
    billing.check({
      plans: [FULL_AUDIT_PLAN_INTRO, FULL_AUDIT_PLAN_REGULAR],
      isTest: BILLING_IS_TEST,
    }),
  ]);

  if (hasActivePayment) {
    // Record the sale the first time we see it (recordPurchaseIfNew dedupes
    // by charge id), so the sold count used for future intro/regular
    // pricing decisions stays accurate. Every subsequent page load also
    // hits this branch, but only the first one actually inserts a row.
    const purchase = oneTimePurchases[0];
    if (purchase) {
      const amount =
        purchase.name === FULL_AUDIT_PLAN_INTRO ? FULL_AUDIT_INTRO_PRICE : FULL_AUDIT_REGULAR_PRICE;
      await recordPurchaseIfNew(session.shop, purchase.id, amount);
    }
  }

  const summary = {
    issueCount,
    totalImpact,
    matchedOrderCount,
    matchedPayoutCount,
    breakdown,
  };

  if (!hasActivePayment) {
    // Free preview: the dollar total and issue breakdown are enough to show
    // there's something worth paying to see, but the itemized findings —
    // the actual product — are withheld from the response entirely rather
    // than sent and merely hidden client-side.
    return {
      connected: true as const,
      clean: false as const,
      unlocked: false as const,
      summary,
      currentPlan,
      hasPayoutsAccount,
      dataErrors,
      dataIncomplete,
    };
  }

  return {
    connected: true as const,
    clean: false as const,
    unlocked: true as const,
    summary,
    hasPayoutsAccount,
    dataErrors,
    dataIncomplete,
    missingOrders,
    duplicatesAndConflicts,
    varianceOrders,
    reviewOrders,
    payoutMismatches,
    unexplainedDeposits,
  };
};

// --- UI ------------------------------------------------------------------

interface FindingItem {
  key: string;
  display: FindingDisplay;
}

function revenueItems(findings: RevenueFinding[]): FindingItem[] {
  return findings.map((finding) => ({
    key: finding.order.id,
    display: describeRevenueFinding(finding),
  }));
}

function settlementItems(findings: SettlementFinding[]): FindingItem[] {
  return findings.map((finding) => ({
    key: finding.payout?.id ?? finding.deposit?.id ?? finding.detail,
    display: describeSettlementFinding(finding),
  }));
}

function FindingSection({
  heading,
  subheading,
  emptyText,
  items,
}: {
  heading: string;
  subheading?: string;
  emptyText: string;
  items: FindingItem[];
}) {
  return (
    <s-section heading={heading}>
      {subheading ? <s-paragraph>{subheading}</s-paragraph> : null}
      {items.length === 0 ? (
        <s-paragraph>{emptyText}</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          {items.map(({ key, display }) => (
            <s-box
              key={key}
              padding="base"
              borderWidth="small"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="base" justifyContent="space-between">
                  <s-text type="strong">{display.headline}</s-text>
                  <s-badge tone={display.tone}>
                    {formatMoney(display.amount, REPORT_CURRENCY)}
                  </s-badge>
                </s-stack>
                <s-paragraph>{display.explanation}</s-paragraph>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      )}
    </s-section>
  );
}

// "Other deposits" is informational and, for most stores, the longest list
// on the page (every non-Shopify deposit — owner contributions, other sales
// channels, etc. — lands here). Rather than always rendering the full list
// like the other sections, show a one-line summary with a toggle so it
// doesn't visually dominate a report that's mostly about real discrepancies.
function OtherDepositsSection({
  heading,
  subheading,
  emptyText,
  items,
}: {
  heading: string;
  subheading?: string;
  emptyText: string;
  items: FindingItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  const total = items.reduce((sum, item) => sum + item.display.amount, 0);

  return (
    <s-section heading={heading}>
      {subheading ? <s-paragraph>{subheading}</s-paragraph> : null}
      {items.length === 0 ? (
        <s-paragraph>{emptyText}</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" justifyContent="space-between">
            <s-text>
              {items.length} other deposit{items.length === 1 ? "" : "s"} totaling{" "}
              {formatMoney(total, REPORT_CURRENCY)} — informational only
            </s-text>
            <s-button onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Hide details" : "Show details"}
            </s-button>
          </s-stack>
          {expanded ? (
            <s-stack direction="block" gap="base">
              {items.map(({ key, display }) => (
                <s-box
                  key={key}
                  padding="base"
                  borderWidth="small"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" gap="base" justifyContent="space-between">
                      <s-text type="strong">{display.headline}</s-text>
                      <s-badge tone={display.tone}>
                        {formatMoney(display.amount, REPORT_CURRENCY)}
                      </s-badge>
                    </s-stack>
                    <s-paragraph>{display.explanation}</s-paragraph>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          ) : null}
        </s-stack>
      )}
    </s-section>
  );
}

const MISSING_DATA_LABELS: Record<string, string> = {
  orders: "Shopify orders",
  payouts: "Shopify payouts",
  salesReceipts: "QuickBooks sales receipts",
  invoices: "QuickBooks invoices",
  payments: "QuickBooks payments",
  deposits: "QuickBooks deposits",
};

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface PreviewSummary {
  issueCount: number;
  totalImpact: number;
  breakdown: {
    missingOrders: number;
    duplicatesAndConflicts: number;
    payoutMismatches: number;
  };
}

// The free preview's whole job is to make the case for paying: lead with
// the dollar figure (that's the entire conversion argument), name the
// categories of problem without giving away specifics, then the CTA.
function PurchaseBanner({
  summary,
  currentPlan,
}: {
  summary: PreviewSummary;
  currentPlan: CurrentPlan;
}) {
  const fetcher = useFetcher<typeof action>();
  const isRequesting = fetcher.state !== "idle";
  const { issueCount, totalImpact, breakdown } = summary;

  const breakdownParts = [
    breakdown.missingOrders > 0 ? pluralize(breakdown.missingOrders, "missing order") : null,
    breakdown.duplicatesAndConflicts > 0
      ? pluralize(breakdown.duplicatesAndConflicts, "duplicate or conflicting record")
      : null,
    breakdown.payoutMismatches > 0 ? pluralize(breakdown.payoutMismatches, "payout mismatch") : null,
  ].filter((part): part is string => part !== null);

  const priceLabel = currentPlan.isIntro
    ? `${formatMoney(currentPlan.price, REPORT_CURRENCY)} (intro price, regular ${formatMoney(FULL_AUDIT_REGULAR_PRICE, REPORT_CURRENCY)})`
    : formatMoney(currentPlan.price, REPORT_CURRENCY);

  return (
    <s-section>
      <s-banner
        heading={`${formatMoney(totalImpact, REPORT_CURRENCY)} in discrepancies found across ${pluralize(issueCount, "issue")}`}
        tone="warning"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>{breakdownParts.join(", ")}.</s-paragraph>
          <s-paragraph>
            Purchase a full audit to see exactly which orders and payouts are affected, with a
            plain-English explanation for each.
          </s-paragraph>
          <s-button
            onClick={() => fetcher.submit({}, { method: "POST" })}
            {...(isRequesting ? { loading: true } : {})}
          >
            Purchase full audit — {priceLabel}
          </s-button>
        </s-stack>
      </s-banner>
    </s-section>
  );
}

export default function ReconciliationReport() {
  const data = useLoaderData<typeof loader>();

  if (!data.connected) {
    return (
      <s-page heading="Reconciliation report">
        <s-section>
          <s-paragraph>
            Not connected to QuickBooks yet. Go to{" "}
            <s-link href="/app/settings">Settings</s-link> to connect.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const missingDataSources = Object.entries(data.dataErrors)
    .filter(([, hasError]) => hasError)
    .map(([key]) => MISSING_DATA_LABELS[key] ?? key);

  const dataWarning = data.dataIncomplete ? (
    <s-section>
      <s-banner heading="Some data couldn't be loaded" tone="warning">
        <s-paragraph>
          {missingDataSources.join(", ")} couldn&apos;t be loaded just now, so this report may
          be incomplete. Try reloading — if it keeps happening, check the connection on the{" "}
          <s-link href="/app/settings">Settings</s-link> page.
        </s-paragraph>
      </s-banner>
    </s-section>
  ) : null;

  if (data.clean) {
    // Nothing was found, so there's nothing to sell — no CTA, no paywall,
    // no billing touched at all for this shop's visit.
    return (
      <s-page heading="Reconciliation report">
        {dataWarning}
        <s-section>
          <s-banner heading="Your books look clean — no discrepancies found" tone="success">
            <s-paragraph>
              {data.matchedOrderCount} orders and {data.matchedPayoutCount} payouts matched
              cleanly. Nothing to review, and nothing to pay for.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const { summary, hasPayoutsAccount } = data;
  const { totalImpact, matchedOrderCount, matchedPayoutCount, issueCount } = summary;

  if (!data.unlocked) {
    return (
      <s-page heading="Reconciliation report">
        {dataWarning}
        <PurchaseBanner summary={summary} currentPlan={data.currentPlan} />
      </s-page>
    );
  }

  return (
    <s-page heading="Reconciliation report">
      {dataWarning}

      <s-section>
        <s-banner
          heading={`Estimated dollar impact: ${formatMoney(totalImpact, REPORT_CURRENCY)}`}
          tone="critical"
        >
          <s-paragraph>
            {`${issueCount} issue${issueCount === 1 ? "" : "s"} found below, on top of ${matchedOrderCount} orders and ${matchedPayoutCount} payouts that matched cleanly.`}
          </s-paragraph>
        </s-banner>
      </s-section>

      <FindingSection
        heading="Missing orders"
        subheading="Orders paid in Shopify with no matching record in QuickBooks."
        emptyText="No missing orders — every paid order has a matching QuickBooks record."
        items={revenueItems(data.missingOrders)}
      />

      <FindingSection
        heading="Duplicates and reference conflicts"
        subheading="Orders that appear to be recorded more than once, or whose QuickBooks reference number doesn't line up."
        emptyText="No duplicate or conflicting records found."
        items={revenueItems(data.duplicatesAndConflicts)}
      />

      <FindingSection
        heading="Recorded, but amounts differ"
        subheading="These orders are recorded in QuickBooks — the total just doesn't match Shopify's exactly. Usually tax, shipping, or a discount calculated differently between the two systems, not lost revenue. Not included in the total above, but worth a look if a gap seems too large to explain that way."
        emptyText="No amount differences to flag."
        items={revenueItems(data.varianceOrders)}
      />

      <FindingSection
        heading="Payout mismatches"
        subheading="Shopify payouts with no matching QuickBooks deposit, or deposits for the wrong amount."
        emptyText={
          hasPayoutsAccount
            ? "Every payout matches a QuickBooks deposit for the right amount."
            : "This store doesn't have a Shopify Payments account, so there are no payouts to check."
        }
        items={settlementItems(data.payoutMismatches)}
      />

      <FindingSection
        heading="Needs review"
        subheading="Not confirmed errors — these matched cleanly on amount and date, but there's no reference number on the QuickBooks side to be sure it's the right record. Worth a glance, not a fire drill."
        emptyText="Nothing needs a second look."
        items={revenueItems(data.reviewOrders)}
      />

      <OtherDepositsSection
        heading="Other deposits"
        subheading="QuickBooks deposits that don't match any Shopify payout — often unrelated business activity (other sales channels, owner contributions, and so on). Informational only; not included in the total above."
        emptyText="No unexplained deposits."
        items={settlementItems(data.unexplainedDeposits)}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
