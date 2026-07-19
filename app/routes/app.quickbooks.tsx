import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  fetchDeposits,
  fetchInvoices,
  fetchPayments,
  fetchSalesReceipts,
  getValidConnection,
  type DepositRow,
  type InvoiceRow,
  type PaymentRow,
  type SalesReceiptRow,
} from "../qbo.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const connection = await getValidConnection(session.shop);

  if (!connection) {
    return { connected: false as const };
  }

  const { accessToken, realmId } = connection;

  // Each entity is fetched independently, with its own error handling, so a
  // problem pulling one type (e.g. a transient QBO API error) doesn't take
  // down the other tables.
  const [salesReceipts, invoices, payments, deposits] = await Promise.all([
    safe(() => fetchSalesReceipts(accessToken, realmId)),
    safe(() => fetchInvoices(accessToken, realmId)),
    safe(() => fetchPayments(accessToken, realmId)),
    safe(() => fetchDeposits(accessToken, realmId)),
  ]);

  return { connected: true as const, salesReceipts, invoices, payments, deposits };
};

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatAmount(amount: number | undefined) {
  return currencyFormatter.format(amount ?? 0);
}

function customerName(ref?: { value: string; name?: string }) {
  return ref?.name ?? ref?.value ?? "—";
}

// A deposit's Line array can mix money from several sources in one bank
// deposit (e.g. two payments swept together), so there's no single
// "customer" the way there is for a sales receipt/invoice/payment — this
// lists every distinct source name/id referenced by the deposit's lines.
function depositSources(row: DepositRow): string {
  const names = (row.Line ?? [])
    .map((line) => line.DepositLineDetail?.Entity)
    .filter((ref): ref is { value: string; name?: string } => Boolean(ref))
    .map((ref) => ref.name ?? ref.value);
  const unique = Array.from(new Set(names));
  return unique.length > 0 ? unique.join(", ") : "—";
}

export default function QuickBooksData() {
  const data = useLoaderData<typeof loader>();

  if (!data.connected) {
    return (
      <s-page heading="QuickBooks data">
        <s-section>
          <s-paragraph>
            Not connected to QuickBooks yet. Go to{" "}
            <s-link href="/app/settings">Settings</s-link> to connect.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const { salesReceipts, invoices, payments, deposits } = data;

  return (
    <s-page heading="QuickBooks data">
      <s-section heading="Sales receipts">
        {salesReceipts.error ? (
          <s-paragraph>Unable to load sales receipts from QuickBooks right now.</s-paragraph>
        ) : salesReceipts.rows.length === 0 ? (
          <s-paragraph>No sales receipts in the last 60 days.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Doc #</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header format="currency">Amount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {salesReceipts.rows.map((row: SalesReceiptRow) => (
                <s-table-row key={row.Id}>
                  <s-table-cell>
                    {dateFormatter.format(new Date(row.TxnDate))}
                  </s-table-cell>
                  <s-table-cell>{row.DocNumber ?? "—"}</s-table-cell>
                  <s-table-cell>{customerName(row.CustomerRef)}</s-table-cell>
                  <s-table-cell>{formatAmount(row.TotalAmt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Invoices">
        {invoices.error ? (
          <s-paragraph>Unable to load invoices from QuickBooks right now.</s-paragraph>
        ) : invoices.rows.length === 0 ? (
          <s-paragraph>No invoices in the last 60 days.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Doc #</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header format="currency">Amount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {invoices.rows.map((row: InvoiceRow) => (
                <s-table-row key={row.Id}>
                  <s-table-cell>
                    {dateFormatter.format(new Date(row.TxnDate))}
                  </s-table-cell>
                  <s-table-cell>{row.DocNumber ?? "—"}</s-table-cell>
                  <s-table-cell>{customerName(row.CustomerRef)}</s-table-cell>
                  <s-table-cell>{formatAmount(row.TotalAmt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Payments">
        {payments.error ? (
          <s-paragraph>Unable to load payments from QuickBooks right now.</s-paragraph>
        ) : payments.rows.length === 0 ? (
          <s-paragraph>No payments in the last 60 days.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Doc #</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header format="currency">Amount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {payments.rows.map((row: PaymentRow) => (
                <s-table-row key={row.Id}>
                  <s-table-cell>
                    {dateFormatter.format(new Date(row.TxnDate))}
                  </s-table-cell>
                  <s-table-cell>{row.PaymentRefNum ?? "—"}</s-table-cell>
                  <s-table-cell>{customerName(row.CustomerRef)}</s-table-cell>
                  <s-table-cell>{formatAmount(row.TotalAmt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Deposits">
        {deposits.error ? (
          <s-paragraph>Unable to load deposits from QuickBooks right now.</s-paragraph>
        ) : deposits.rows.length === 0 ? (
          <s-paragraph>No deposits in the last 60 days.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Source(s)</s-table-header>
              <s-table-header format="currency">Amount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {deposits.rows.map((row: DepositRow) => (
                <s-table-row key={row.Id}>
                  <s-table-cell>
                    {dateFormatter.format(new Date(row.TxnDate))}
                  </s-table-cell>
                  <s-table-cell>{depositSources(row)}</s-table-cell>
                  <s-table-cell>{formatAmount(row.TotalAmt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
