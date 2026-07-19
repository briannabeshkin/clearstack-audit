import type { OrderRow, PayoutRow } from "./shopify-data.server";
import type {
  DepositRow,
  InvoiceRow,
  PaymentRow,
  SalesReceiptRow,
} from "./qbo.server";

// --- The common model ------------------------------------------------------
//
// Shopify orders and QBO SalesReceipts/Invoices are both "one row per sale"
// events — they go in the `revenue` bucket. Shopify payouts and QBO deposits
// are both "one row per bank-hitting batch" events — they go in the
// `settlement` bucket. Nothing is ever compared across buckets; an order is
// never matched against a deposit, a payout is never matched against an
// invoice. QBO Payments are normalized too (bucket "revenue") but are not
// matched against orders directly — they only exist here so a Deposit's
// LinkedTxn can be resolved back to something with a customer/reference on
// it (see matchSettlement).

export type Source = "shopify" | "quickbooks";
export type RecordType =
  | "order"
  | "payout"
  | "salesReceipt"
  | "invoice"
  | "payment"
  | "deposit";
export type Bucket = "revenue" | "settlement";

export interface NormalizedTransaction {
  /** Synthetic dedup key: `${source}:${recordType}:${nativeId}`. */
  id: string;
  /** The raw id from the source system — used to resolve LinkedTxn refs. */
  nativeId: string;
  source: Source;
  recordType: RecordType;
  bucket: Bucket;
  /** Date-only (YYYY-MM-DD), so day-window comparisons aren't thrown off by
   *  time-of-day/timezone on the Shopify timestamps. */
  date: string;
  amount: number;
  currency: string;
  /** Digits-only reference used for exact matching (Shopify order name with
   *  the "#" stripped, QBO DocNumber/PaymentRefNum). Null if the source
   *  record has no reference at all (e.g. a Deposit). */
  reference: string | null;
  /** The original human-readable reference, for messages and UI. */
  displayReference: string | null;
  status: string | null;
  counterpartyName: string | null;
  /** Only populated for deposits: every QBO TxnId referenced by the
   *  deposit's lines (the Payments/SalesReceipts swept into it). */
  linkedTxnIds: string[];
  /** Original row, kept for drill-down/debugging. */
  raw: unknown;
}

// All QBO amounts in this app are read via the Query API without a
// CurrencyRef (single-currency company assumed — matches the hardcoded
// "USD" formatting already used in app.quickbooks.tsx).
const QBO_CURRENCY = "USD";

function referenceDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** (laterIso - earlierIso) in whole days, date-only. */
function daysBetween(laterIso: string, earlierIso: string): number {
  const later = Date.parse(`${toDateOnly(laterIso)}T00:00:00Z`);
  const earlier = Date.parse(`${toDateOnly(earlierIso)}T00:00:00Z`);
  return (later - earlier) / (24 * 60 * 60 * 1000);
}

function centsEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

// --- Amount tolerance bands --------------------------------------------
//
// Real bookkeeping totals rarely match to the cent: QuickBooks and Shopify
// compute tax, shipping, and discounts independently, and rounding drifts.
// Requiring exact amounts turns normal drift into false "missing order"
// findings — which cost more trust than a missed finding does. So amount
// comparisons use two bands instead of one cutoff:
//
//   - "clean": pure rounding noise. Within this, it's a plain match, no
//     callout.
//   - "variance": plausible tax/shipping/discount drift. Within this (but
//     outside "clean"), it's still the same transaction, just recorded for
//     a different total — surfaced as its own finding, not hidden and not
//     treated as an error.
//
// Beyond the variance band, the amounts don't plausibly describe the same
// sale, and it's treated as a real discrepancy.
//
// The variance band is wider for reference-anchored matches (tier 1) than
// for amount+date-only matches (tier 2): a shared doc number is independent
// evidence of identity, so there's more room to attribute a gap to
// bookkeeping drift. Without that anchor, a wide tolerance risks pairing an
// order with a different, coincidentally-similar order instead of missing
// it — so tier 2 stays tighter.
//
// Starting points, not measured against real merchant data yet — cheap to
// retune since they're just constants.
const CLEAN_TOLERANCE_FLOOR = 0.5;
const CLEAN_TOLERANCE_PCT = 0.01;
const REFERENCE_VARIANCE_TOLERANCE_FLOOR = 10;
const REFERENCE_VARIANCE_TOLERANCE_PCT = 0.25;
const FUZZY_VARIANCE_TOLERANCE_FLOOR = 5;
const FUZZY_VARIANCE_TOLERANCE_PCT = 0.15;

function withinTolerance(
  orderAmount: number,
  candidateAmount: number,
  floor: number,
  pct: number,
): boolean {
  const tolerance = Math.max(floor, Math.abs(orderAmount) * pct);
  return Math.abs(orderAmount - candidateAmount) <= tolerance;
}

function isClean(orderAmount: number, candidateAmount: number): boolean {
  return withinTolerance(orderAmount, candidateAmount, CLEAN_TOLERANCE_FLOOR, CLEAN_TOLERANCE_PCT);
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const RECORD_LABELS: Record<RecordType, string> = {
  order: "order",
  payout: "payout",
  salesReceipt: "sales receipt",
  invoice: "invoice",
  payment: "payment",
  deposit: "deposit",
};

function describe(record: NormalizedTransaction): string {
  const ref = record.displayReference ? ` ${record.displayReference}` : "";
  return `QuickBooks ${RECORD_LABELS[record.recordType]}${ref} on ${record.date}`;
}

// --- Normalizers -------------------------------------------------------

export function normalizeOrder(order: OrderRow): NormalizedTransaction {
  return {
    id: `shopify:order:${order.id}`,
    nativeId: order.id,
    source: "shopify",
    recordType: "order",
    bucket: "revenue",
    date: toDateOnly(order.createdAt),
    amount: Number(order.totalPriceSet.shopMoney.amount),
    currency: order.totalPriceSet.shopMoney.currencyCode,
    reference: referenceDigits(order.name),
    displayReference: order.name,
    status: order.displayFinancialStatus,
    counterpartyName: order.customer?.displayName ?? null,
    linkedTxnIds: [],
    raw: order,
  };
}

export function normalizePayout(payout: PayoutRow): NormalizedTransaction {
  return {
    id: `shopify:payout:${payout.id}`,
    nativeId: payout.id,
    source: "shopify",
    recordType: "payout",
    bucket: "settlement",
    date: toDateOnly(payout.issuedAt),
    amount: Number(payout.net.amount),
    currency: payout.net.currencyCode,
    reference: null,
    displayReference: null,
    status: payout.status,
    counterpartyName: null,
    linkedTxnIds: [],
    raw: payout,
  };
}

export function normalizeSalesReceipt(
  row: SalesReceiptRow,
): NormalizedTransaction {
  return {
    id: `quickbooks:salesReceipt:${row.Id}`,
    nativeId: row.Id,
    source: "quickbooks",
    recordType: "salesReceipt",
    bucket: "revenue",
    date: toDateOnly(row.TxnDate),
    amount: row.TotalAmt,
    currency: QBO_CURRENCY,
    reference: referenceDigits(row.DocNumber),
    displayReference: row.DocNumber ?? null,
    status: null,
    counterpartyName: row.CustomerRef?.name ?? null,
    linkedTxnIds: [],
    raw: row,
  };
}

export function normalizeInvoice(row: InvoiceRow): NormalizedTransaction {
  return {
    id: `quickbooks:invoice:${row.Id}`,
    nativeId: row.Id,
    source: "quickbooks",
    recordType: "invoice",
    bucket: "revenue",
    date: toDateOnly(row.TxnDate),
    amount: row.TotalAmt,
    currency: QBO_CURRENCY,
    reference: referenceDigits(row.DocNumber),
    displayReference: row.DocNumber ?? null,
    status: row.Balance == null ? null : row.Balance > 0 ? "open" : "paid",
    counterpartyName: row.CustomerRef?.name ?? null,
    linkedTxnIds: [],
    raw: row,
  };
}

export function normalizePayment(row: PaymentRow): NormalizedTransaction {
  return {
    id: `quickbooks:payment:${row.Id}`,
    nativeId: row.Id,
    source: "quickbooks",
    recordType: "payment",
    bucket: "revenue",
    date: toDateOnly(row.TxnDate),
    amount: row.TotalAmt,
    currency: QBO_CURRENCY,
    reference: referenceDigits(row.PaymentRefNum),
    displayReference: row.PaymentRefNum ?? null,
    status: null,
    counterpartyName: row.CustomerRef?.name ?? null,
    linkedTxnIds: [],
    raw: row,
  };
}

export function normalizeDeposit(row: DepositRow): NormalizedTransaction {
  const linkedTxnIds = Array.from(
    new Set(
      (row.Line ?? []).flatMap((line) =>
        (line.LinkedTxn ?? []).map((txn) => txn.TxnId),
      ),
    ),
  );
  return {
    id: `quickbooks:deposit:${row.Id}`,
    nativeId: row.Id,
    source: "quickbooks",
    recordType: "deposit",
    bucket: "settlement",
    date: toDateOnly(row.TxnDate),
    amount: row.TotalAmt,
    currency: QBO_CURRENCY,
    reference: null,
    displayReference: null,
    status: null,
    // Deposits can sweep in money from several different customers at once,
    // so there's no single counterparty — depositSources() in the
    // QuickBooks data page lists them for display; linkedTxnIds carries the
    // same information for matching purposes.
    counterpartyName: null,
    linkedTxnIds,
    raw: row,
  };
}

// --- Revenue matching: orders vs. SalesReceipts/Invoices -----------------

export type RevenueFindingType =
  | "matched"
  | "matched-fuzzy"
  | "matched-variance"
  | "reference-conflict"
  | "duplicate"
  | "missing-order";

export interface RevenueFinding {
  type: RevenueFindingType;
  order: NormalizedTransaction;
  matches: NormalizedTransaction[];
  detail: string;
}

export interface RevenueMatchResult {
  findings: RevenueFinding[];
  /** QBO revenue records that didn't get claimed by any order — may be
   *  legitimate non-Shopify revenue (e.g. a wholesale invoice), so this is
   *  exposed for transparency rather than turned into a finding. */
  unmatchedQboRevenue: NormalizedTransaction[];
}

// Real bookkeeping lags — a Friday order often posts to QuickBooks on
// Monday. Too narrow a window turns normal lag into false "missing order"
// findings, and false alarms cost more trust than they're worth.
const REVENUE_FUZZY_WINDOW_DAYS = 3;

export function matchRevenue(
  orders: NormalizedTransaction[],
  qboRevenue: NormalizedTransaction[],
): RevenueMatchResult {
  const byReference = new Map<string, NormalizedTransaction[]>();
  for (const record of qboRevenue) {
    if (!record.reference) continue;
    const bucket = byReference.get(record.reference);
    if (bucket) {
      bucket.push(record);
    } else {
      byReference.set(record.reference, [record]);
    }
  }

  // QBO auto-numbers its own documents — DocNumber often has nothing to do
  // with the Shopify order number, and a QBO company's own sequence can
  // easily land in the same numeric range as a store's order numbers by
  // pure coincidence. This set is what tells the two apart: a reference is
  // only "somebody else's order" if it actually belongs to an order we
  // fetched, not just because it's a number that isn't this order's.
  const orderReferences = new Set(
    orders.map((order) => order.reference).filter((ref): ref is string => ref !== null),
  );

  const claimed = new Set<string>();
  const findings: RevenueFinding[] = [];

  const nearestByDate = (candidates: NormalizedTransaction[], to: NormalizedTransaction) =>
    candidates.reduce((closest, candidate) =>
      Math.abs(daysBetween(candidate.date, to.date)) <
      Math.abs(daysBetween(closest.date, to.date))
        ? candidate
        : closest,
    );

  for (const order of orders) {
    const exact = order.reference ? byReference.get(order.reference) ?? [] : [];

    // A shared reference number alone isn't enough to call it a match —
    // DocNumber sequences aren't unique across SalesReceipt/Invoice, and
    // QBO's own auto-numbering can coincidentally land in the same range as
    // a store's order numbers (a QBO company numbering its documents
    // 1001-1042 is not "pointing at" Shopify order #1001 just because the
    // numbers overlap). Amount is what tells a real reference match from a
    // numeric coincidence: real totals routinely drift from Shopify's (tax,
    // shipping, and discounts are computed independently on each side), so
    // amount agreeing exactly or within a plausible bookkeeping range is
    // still treated as the same sale — but a reference match whose amount
    // isn't even in the same neighborhood almost certainly isn't the same
    // transaction at all, and gets treated as no match rather than a flagged
    // conflict, so the order still gets a fair shot at tier 2 below.
    const cleanMatches = exact.filter(
      (record) => record.currency === order.currency && isClean(order.amount, record.amount),
    );
    const varianceMatches = exact.filter(
      (record) =>
        !cleanMatches.includes(record) &&
        record.currency === order.currency &&
        withinTolerance(
          order.amount,
          record.amount,
          REFERENCE_VARIANCE_TOLERANCE_FLOOR,
          REFERENCE_VARIANCE_TOLERANCE_PCT,
        ),
    );

    if (cleanMatches.length === 1) {
      claimed.add(cleanMatches[0].id);
      findings.push({
        type: "matched",
        order,
        matches: cleanMatches,
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${describe(cleanMatches[0])}.`,
      });
      continue;
    }

    if (cleanMatches.length > 1) {
      cleanMatches.forEach((match) => claimed.add(match.id));
      findings.push({
        type: "duplicate",
        order,
        matches: cleanMatches,
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${cleanMatches.length} QuickBooks records sharing the same reference number and amount — likely a duplicate from a re-sync.`,
      });
      continue;
    }

    if (varianceMatches.length > 0) {
      // Reference matched, amount is close but not exact — claim it so it
      // can't also get scooped up by some other order's tier-2 match.
      varianceMatches.forEach((match) => claimed.add(match.id));
      const primary = nearestByDate(varianceMatches, order);
      findings.push({
        type: "matched-variance",
        order,
        matches: varianceMatches,
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${describe(primary)} by reference number, but that record is ${money(primary.amount, primary.currency)} — a ${money(Math.abs(order.amount - primary.amount), order.currency)} difference, likely tax, shipping, or a discount computed differently between the two systems.`,
      });
      continue;
    }

    // Reference matched but the amount is nowhere close (or there was no
    // reference match at all) — don't claim anything and don't report a
    // conflict here. Fall back to amount + date among still-unclaimed
    // records, using the tier-2 variance band (tighter than tier 1's, since
    // there's no reference number anchoring identity here).
    const fuzzyCandidates = qboRevenue.filter(
      (record) =>
        !claimed.has(record.id) &&
        record.currency === order.currency &&
        withinTolerance(
          order.amount,
          record.amount,
          FUZZY_VARIANCE_TOLERANCE_FLOOR,
          FUZZY_VARIANCE_TOLERANCE_PCT,
        ) &&
        Math.abs(daysBetween(record.date, order.date)) <= REVENUE_FUZZY_WINDOW_DAYS,
    );

    if (fuzzyCandidates.length === 0) {
      findings.push({
        type: "missing-order",
        order,
        matches: [],
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) has no matching QuickBooks sales receipt or invoice within ${REVENUE_FUZZY_WINDOW_DAYS} days.`,
      });
      continue;
    }

    // A candidate whose reference belongs to a DIFFERENT order we actually
    // fetched is a conflict worth flagging distinctly — amount and date are
    // at least in the right neighborhood, but the QBO record claims to
    // belong to a real, different order, which is often what a duplicate
    // from a re-sync looks like. A candidate whose reference doesn't match
    // any order at all isn't evidence of anything — it's just QBO's own
    // numbering — so it's treated the same as having no reference.
    const conflicting = fuzzyCandidates.filter(
      (record) =>
        record.reference &&
        record.reference !== order.reference &&
        orderReferences.has(record.reference),
    );
    const clean = fuzzyCandidates.filter((record) => !conflicting.includes(record));

    if (conflicting.length > 0) {
      const primary = nearestByDate(conflicting, order);
      claimed.add(primary.id);
      findings.push({
        type: "reference-conflict",
        order,
        matches: conflicting,
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${describe(primary)} by amount and date, but its reference (${primary.displayReference}) doesn't match the order number — possible duplicate from a re-sync.`,
      });
      continue;
    }

    const primary = nearestByDate(clean, order);
    claimed.add(primary.id);

    if (isClean(order.amount, primary.amount)) {
      findings.push({
        type: "matched-fuzzy",
        order,
        matches: [primary],
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${describe(primary)} by amount and date (no reference number on the QuickBooks side to confirm).`,
      });
    } else {
      findings.push({
        type: "matched-variance",
        order,
        matches: [primary],
        detail: `Order ${order.displayReference} (${money(order.amount, order.currency)}) matches ${describe(primary)} by date, but that record is ${money(primary.amount, primary.currency)} — a ${money(Math.abs(order.amount - primary.amount), order.currency)} difference, likely tax, shipping, or a discount computed differently between the two systems (no reference number on the QuickBooks side to confirm the match itself).`,
      });
    }
  }

  const unmatchedQboRevenue = qboRevenue.filter((record) => !claimed.has(record.id));

  return { findings, unmatchedQboRevenue };
}

// --- Settlement matching: payouts vs. deposits ----------------------------

export type SettlementFindingType =
  | "matched"
  | "amount-mismatch"
  | "not-deposited"
  | "unexplained-deposit";

export interface SettlementFinding {
  type: SettlementFindingType;
  payout: NormalizedTransaction | null;
  deposit: NormalizedTransaction | null;
  /** SalesReceipts/Payments this deposit's LinkedTxn resolves to, when
   *  available — traces payout -> deposit -> underlying receipts instead of
   *  leaving the match as a bare amount/date coincidence. */
  linkedRevenue: NormalizedTransaction[];
  detail: string;
}

// Deposits typically post 0-3 business days after the payout that funds
// them, depending on the bank.
const SETTLEMENT_WINDOW_DAYS = 3;

export function matchSettlement(
  payouts: NormalizedTransaction[],
  deposits: NormalizedTransaction[],
  qboRevenueById: Map<string, NormalizedTransaction>,
): SettlementFinding[] {
  const claimed = new Set<string>();
  const findings: SettlementFinding[] = [];

  const resolveLinked = (deposit: NormalizedTransaction) =>
    deposit.linkedTxnIds
      .map((txnId) => qboRevenueById.get(txnId))
      .filter((record): record is NormalizedTransaction => Boolean(record));

  const linkedSuffix = (linked: NormalizedTransaction[]) =>
    linked.length > 0
      ? `, tracing to ${linked.length} linked QuickBooks record${linked.length === 1 ? "" : "s"}`
      : "";

  for (const payout of payouts) {
    // Deposits post on or after the payout that funds them, never before.
    const candidates = deposits.filter(
      (deposit) =>
        !claimed.has(deposit.id) &&
        deposit.currency === payout.currency &&
        daysBetween(deposit.date, payout.date) >= 0 &&
        daysBetween(deposit.date, payout.date) <= SETTLEMENT_WINDOW_DAYS,
    );

    const exact = candidates.find((deposit) => centsEqual(deposit.amount, payout.amount));
    if (exact) {
      claimed.add(exact.id);
      const linkedRevenue = resolveLinked(exact);
      findings.push({
        type: "matched",
        payout,
        deposit: exact,
        linkedRevenue,
        detail: `Payout of ${money(payout.amount, payout.currency)} issued ${payout.date} matches a deposit on ${exact.date}${linkedSuffix(linkedRevenue)}.`,
      });
      continue;
    }

    if (candidates.length > 0) {
      const nearest = candidates.reduce((closest, candidate) =>
        Math.abs(candidate.amount - payout.amount) < Math.abs(closest.amount - payout.amount)
          ? candidate
          : closest,
      );
      claimed.add(nearest.id);
      const linkedRevenue = resolveLinked(nearest);
      const difference = money(Math.abs(nearest.amount - payout.amount), payout.currency);
      findings.push({
        type: "amount-mismatch",
        payout,
        deposit: nearest,
        linkedRevenue,
        detail: `Payout of ${money(payout.amount, payout.currency)} issued ${payout.date} has a deposit on ${nearest.date} for ${money(nearest.amount, nearest.currency)} instead — a ${difference} difference${linkedSuffix(linkedRevenue)}.`,
      });
      continue;
    }

    findings.push({
      type: "not-deposited",
      payout,
      deposit: null,
      linkedRevenue: [],
      detail: `Payout of ${money(payout.amount, payout.currency)} issued ${payout.date} has no matching QuickBooks deposit within ${SETTLEMENT_WINDOW_DAYS} days.`,
    });
  }

  for (const deposit of deposits) {
    if (claimed.has(deposit.id)) continue;
    const linkedRevenue = resolveLinked(deposit);
    findings.push({
      type: "unexplained-deposit",
      payout: null,
      deposit,
      linkedRevenue,
      detail: `Deposit of ${money(deposit.amount, deposit.currency)} on ${deposit.date} doesn't match any Shopify payout${linkedSuffix(linkedRevenue)}.`,
    });
  }

  return findings;
}

// --- Dollar impact ---------------------------------------------------------
//
// The dollar figure attributed to each finding type — this is what the
// findings page sums into its headline "estimated dollar impact" number.
// "matched" and "matched-fuzzy" findings aren't errors (fuzzy matches are
// surfaced separately for review, not counted as a problem), so both
// contribute 0.

export function revenueFindingImpact(finding: RevenueFinding): number {
  switch (finding.type) {
    case "missing-order":
      // Revenue that may never make it into QuickBooks.
      return finding.order.amount;
    case "duplicate":
      // The order itself is fine; the extra copies overstate revenue.
      return finding.order.amount * (finding.matches.length - 1);
    case "reference-conflict":
      // Unconfirmed — could be a real duplicate or a coincidence — but the
      // full amount is what's at stake until it's checked.
      return finding.order.amount;
    case "matched":
    case "matched-fuzzy":
    case "matched-variance":
      // Recorded, just for a different total — not lost or overstated
      // revenue, so it doesn't belong in the headline number. Still a real,
      // visible finding (see the "Recorded, but amounts differ" section on
      // the report), just not one that should make the total look scarier
      // than the situation warrants.
      return 0;
  }
}

export function settlementFindingImpact(finding: SettlementFinding): number {
  switch (finding.type) {
    case "not-deposited":
      return finding.payout?.amount ?? 0;
    case "amount-mismatch":
      return Math.abs((finding.deposit?.amount ?? 0) - (finding.payout?.amount ?? 0));
    case "unexplained-deposit":
      // Informational, not a confirmed problem — every merchant has some
      // non-Shopify deposits (owner contributions, other sales channels,
      // etc.), and counting them here would make the headline number noisy
      // and misleading rather than useful. Surfaced in its own low-priority
      // section on the report instead.
      return 0;
    case "matched":
      return 0;
  }
}

// --- Orchestration -----------------------------------------------------

export interface ReconciliationInput {
  orders: OrderRow[];
  payouts: PayoutRow[];
  salesReceipts: SalesReceiptRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  deposits: DepositRow[];
}

export interface ReconciliationResult {
  revenue: RevenueMatchResult;
  settlement: SettlementFinding[];
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const normalizedOrders = input.orders.map(normalizeOrder);
  const normalizedPayouts = input.payouts.map(normalizePayout);
  const normalizedSalesReceipts = input.salesReceipts.map(normalizeSalesReceipt);
  const normalizedInvoices = input.invoices.map(normalizeInvoice);
  const normalizedPayments = input.payments.map(normalizePayment);
  const normalizedDeposits = input.deposits.map(normalizeDeposit);

  const qboRevenue = [...normalizedSalesReceipts, ...normalizedInvoices];
  const revenue = matchRevenue(normalizedOrders, qboRevenue);

  // Deposit LinkedTxn entries point at SalesReceipts or Payments (the
  // actual money-received records), never at Invoices directly — so the
  // lookup index is built from those two, not from normalizedInvoices.
  const qboRevenueById = new Map<string, NormalizedTransaction>();
  for (const record of [...normalizedSalesReceipts, ...normalizedPayments]) {
    qboRevenueById.set(record.nativeId, record);
  }

  const settlement = matchSettlement(normalizedPayouts, normalizedDeposits, qboRevenueById);

  return { revenue, settlement };
}
