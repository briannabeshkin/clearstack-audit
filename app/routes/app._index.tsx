import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate, BILLING_IS_TEST, FULL_AUDIT_PLAN } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  fetchRecentOrders,
  fetchRecentPayouts,
  type OrderRow,
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
} from "../reconcile.server";
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

async function safe<T>(fn: () => Promise<T[]>): Promise<Fetched<T>> {
  try {
    return { rows: await fn(), error: false };
  } catch {
    return { rows: [], error: true };
  }
}

const REPORT_CURRENCY = "USD";

// The purchase is a one-time unlock, not a per-run charge — the merchant
// pays $49 once and every future reload of this page shows the full
// itemized report from then on, rather than being charged again each time
// the data is re-pulled.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  await billing.request({
    plan: FULL_AUDIT_PLAN,
    isTest: BILLING_IS_TEST,
    returnUrl: `${process.env.SHOPIFY_APP_URL ?? ""}/app?shop=${encodeURIComponent(session.shop)}`,
  });
  // billing.request() always throws a redirect (to Shopify's confirmation
  // page, or — for embedded XHR requests like this one — a 401 carrying
  // App Bridge redirect headers that the client-side script turns into a
  // top-level navigation). This line never actually runs.
  return null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const connection = await getValidConnection(session.shop);

  if (!connection) {
    return { connected: false as const };
  }

  const { accessToken, realmId } = connection;

  // Kick every fetch off concurrently. Shopify and QBO are handled with
  // their established patterns (try/catch and safe() respectively, matching
  // app.quickbooks.tsx) so one failing source degrades its own section
  // instead of taking down the whole report.
  const ordersRequest = fetchRecentOrders(admin.graphql);
  const payoutsRequest = fetchRecentPayouts(admin.graphql);
  const salesReceiptsRequest = safe(() => fetchSalesReceipts(accessToken, realmId));
  const invoicesRequest = safe(() => fetchInvoices(accessToken, realmId));
  const paymentsRequest = safe(() => fetchPayments(accessToken, realmId));
  const depositsRequest = safe(() => fetchDeposits(accessToken, realmId));
  const billingRequest = billing.check({ plans: [FULL_AUDIT_PLAN], isTest: BILLING_IS_TEST });

  let orders: OrderRow[] = [];
  let ordersError = false;
  try {
    orders = await ordersRequest;
  } catch {
    ordersError = true;
  }

  let payouts: PayoutRow[] = [];
  let hasPayoutsAccount = false;
  let payoutsError = false;
  try {
    const result = await payoutsRequest;
    payouts = result.payouts;
    hasPayoutsAccount = result.hasPayoutsAccount;
  } catch {
    payoutsError = true;
  }

  const [salesReceipts, invoices, payments, deposits, { hasActivePayment }] = await Promise.all([
    salesReceiptsRequest,
    invoicesRequest,
    paymentsRequest,
    depositsRequest,
    billingRequest,
  ]);

  const dataErrors = {
    orders: ordersError,
    payouts: payoutsError,
    salesReceipts: salesReceipts.error,
    invoices: invoices.error,
    payments: payments.error,
    deposits: deposits.error,
  };
  const dataIncomplete = Object.values(dataErrors).some(Boolean);

  const { revenue, settlement } = reconcile({
    orders,
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

  const summary = {
    issueCount,
    totalImpact,
    matchedOrderCount,
    matchedPayoutCount,
  };

  if (!hasActivePayment) {
    // Free preview: the summary numbers above are enough to show there's
    // something worth paying to see, but the itemized findings — the actual
    // product — are withheld from the response entirely rather than sent
    // and merely hidden client-side.
    return {
      connected: true as const,
      unlocked: false as const,
      summary,
      hasPayoutsAccount,
      dataErrors,
      dataIncomplete,
    };
  }

  return {
    connected: true as const,
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

function PurchaseBanner({ issueCount }: { issueCount: number }) {
  const fetcher = useFetcher<typeof action>();
  const isRequesting = fetcher.state !== "idle";

  return (
    <s-section>
      <s-banner
        heading={
          issueCount === 0
            ? "No discrepancies found in the free preview"
            : `${issueCount} issue${issueCount === 1 ? "" : "s"} found`
        }
        tone={issueCount === 0 ? "success" : "warning"}
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The free preview shows how many issues were found and the total dollar impact.
            Purchase a full audit for $49 (one time) to see exactly which orders and payouts
            are affected, with a plain-English explanation for each.
          </s-paragraph>
          <s-button
            onClick={() => fetcher.submit({}, { method: "POST" })}
            {...(isRequesting ? { loading: true } : {})}
          >
            Purchase full audit — $49
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

  const { summary, dataErrors, dataIncomplete, hasPayoutsAccount } = data;
  const { issueCount, totalImpact, matchedOrderCount, matchedPayoutCount } = summary;

  const missingDataSources = Object.entries(dataErrors)
    .filter(([, hasError]) => hasError)
    .map(([key]) => MISSING_DATA_LABELS[key] ?? key);

  const dataWarning = dataIncomplete ? (
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

  if (!data.unlocked) {
    return (
      <s-page heading="Reconciliation report">
        {dataWarning}
        <PurchaseBanner issueCount={issueCount} />
      </s-page>
    );
  }

  return (
    <s-page heading="Reconciliation report">
      {dataWarning}

      <s-section>
        <s-banner
          heading={
            issueCount === 0
              ? "No discrepancies found"
              : `Estimated dollar impact: ${formatMoney(totalImpact, REPORT_CURRENCY)}`
          }
          tone={issueCount === 0 ? "success" : "critical"}
        >
          <s-paragraph>
            {issueCount === 0
              ? `Everything checked out — ${matchedOrderCount} orders and ${matchedPayoutCount} payouts matched cleanly.`
              : `${issueCount} issue${issueCount === 1 ? "" : "s"} found below, on top of ${matchedOrderCount} orders and ${matchedPayoutCount} payouts that matched cleanly.`}
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
