import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  matchRevenue,
  matchSettlement,
  reconcile,
  normalizeOrder,
  normalizePayout,
  normalizeSalesReceipt,
  normalizeInvoice,
  normalizePayment,
  normalizeDeposit,
  revenueFindingImpact,
  settlementFindingImpact,
  type NormalizedTransaction,
} from "./reconcile.ts";
import type { OrderRow, PayoutRow } from "./shopify-data.server";
import type {
  SalesReceiptRow,
  InvoiceRow,
  PaymentRow,
  DepositRow,
} from "./qbo.server";

// --- Fixture builders -------------------------------------------------
//
// Each builder takes only the fields a given test actually cares about
// (plus the plain `amount` number, which gets formatted into whichever
// shape that record type expects) and fills in sane, unambiguous defaults
// for the rest — so each test reads as "here's what's different about this
// record" rather than a full, noisy object literal every time.

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

function order(opts: {
  name: string;
  amount: number;
  createdAt?: string;
  customer?: { displayName: string } | null;
}): OrderRow {
  return {
    id: nextId("gid://shopify/Order/"),
    name: opts.name,
    createdAt: opts.createdAt ?? "2026-07-01T12:00:00Z",
    displayFinancialStatus: "PAID",
    totalPriceSet: { shopMoney: { amount: opts.amount.toFixed(2), currencyCode: "USD" } },
    customer: opts.customer ?? null,
  };
}

function payout(opts: { amount: number; issuedAt?: string }): PayoutRow {
  const zero = { amount: "0.00", currencyCode: "USD" };
  return {
    id: nextId("gid://shopify/Payout/"),
    issuedAt: opts.issuedAt ?? "2026-07-01T00:00:00Z",
    status: "paid",
    net: { amount: opts.amount.toFixed(2), currencyCode: "USD" },
    summary: {
      chargesGross: zero,
      chargesFee: zero,
      refundsFeeGross: zero,
      adjustmentsGross: zero,
      adjustmentsFee: zero,
    },
  };
}

function salesReceipt(opts: { amount: number; DocNumber?: string; TxnDate?: string }): SalesReceiptRow {
  return {
    Id: nextId("SR"),
    DocNumber: opts.DocNumber,
    TxnDate: opts.TxnDate ?? "2026-07-01",
    TotalAmt: opts.amount,
  };
}

function invoice(opts: { amount: number; DocNumber?: string; TxnDate?: string }): InvoiceRow {
  return {
    Id: nextId("INV"),
    DocNumber: opts.DocNumber,
    TxnDate: opts.TxnDate ?? "2026-07-01",
    TotalAmt: opts.amount,
  };
}

function payment(opts: { amount: number; TxnDate?: string }): PaymentRow {
  return {
    Id: nextId("PMT"),
    TxnDate: opts.TxnDate ?? "2026-07-01",
    TotalAmt: opts.amount,
  };
}

function deposit(opts: {
  amount: number;
  TxnDate?: string;
  Line?: DepositRow["Line"];
}): DepositRow {
  return {
    Id: nextId("DEP"),
    TxnDate: opts.TxnDate ?? "2026-07-01",
    TotalAmt: opts.amount,
    Line: opts.Line,
  };
}

function findingFor<T extends { order: NormalizedTransaction }>(findings: T[], name: string): T {
  const found = findings.find((f) => f.order.displayReference === name);
  assert.ok(found, `expected a finding for order ${name}`);
  return found;
}

// --- Revenue matching ---------------------------------------------------

describe("matchRevenue", () => {
  test("exact reference + clean amount match => matched, zero impact", () => {
    const o = order({ name: "#1001", amount: 100 });
    const sr = salesReceipt({ DocNumber: "1001", amount: 100, TxnDate: "2026-07-01" });
    const { findings } = matchRevenue([normalizeOrder(o)], [normalizeSalesReceipt(sr)]);
    const finding = findingFor(findings, "#1001");
    assert.equal(finding.type, "matched");
    assert.equal(revenueFindingImpact(finding), 0);
  });

  test("two records sharing the same reference + clean amount => duplicate", () => {
    const o = order({ name: "#1002", amount: 50 });
    const sr1 = salesReceipt({ DocNumber: "1002", amount: 50 });
    const sr2 = salesReceipt({ DocNumber: "1002", amount: 50 });
    const { findings } = matchRevenue(
      [normalizeOrder(o)],
      [normalizeSalesReceipt(sr1), normalizeSalesReceipt(sr2)],
    );
    const finding = findingFor(findings, "#1002");
    assert.equal(finding.type, "duplicate");
    // One order's worth of revenue is legitimate; the extra copy overstates it.
    assert.equal(revenueFindingImpact(finding), 50);
  });

  test("reference matches but amount is off within the reference-tier variance band => matched-variance, zero impact", () => {
    const o = order({ name: "#1003", amount: 200 });
    const sr = salesReceipt({ DocNumber: "1003", amount: 215 }); // $15 off, within band
    const { findings } = matchRevenue([normalizeOrder(o)], [normalizeSalesReceipt(sr)]);
    const finding = findingFor(findings, "#1003");
    assert.equal(finding.type, "matched-variance");
    assert.equal(revenueFindingImpact(finding), 0);
  });

  test("no matching QuickBooks record within the fuzzy window => missing-order, full amount at risk", () => {
    const o = order({ name: "#1004", amount: 75, createdAt: "2026-07-04T00:00:00Z" });
    const { findings } = matchRevenue([normalizeOrder(o)], []);
    const finding = findingFor(findings, "#1004");
    assert.equal(finding.type, "missing-order");
    assert.equal(revenueFindingImpact(finding), 75);
  });

  test("no reference on either side, but amount+date match cleanly and nearby => matched-fuzzy", () => {
    const o = order({ name: "#1005", amount: 40, createdAt: "2026-07-05T00:00:00Z" });
    const sr = salesReceipt({ amount: 40, TxnDate: "2026-07-06" }); // no DocNumber, 1 day later
    const { findings } = matchRevenue([normalizeOrder(o)], [normalizeSalesReceipt(sr)]);
    const finding = findingFor(findings, "#1005");
    assert.equal(finding.type, "matched-fuzzy");
    assert.equal(revenueFindingImpact(finding), 0);
  });

  test("no reference, amount close but not clean, within fuzzy window => matched-variance (tier 2)", () => {
    const o = order({ name: "#1006", amount: 60, createdAt: "2026-07-07T00:00:00Z" });
    const sr = salesReceipt({ amount: 65, TxnDate: "2026-07-08" }); // $5 off, no DocNumber
    const { findings } = matchRevenue([normalizeOrder(o)], [normalizeSalesReceipt(sr)]);
    const finding = findingFor(findings, "#1006");
    assert.equal(finding.type, "matched-variance");
    assert.equal(revenueFindingImpact(finding), 0);
  });

  test("a QuickBooks record whose reference belongs to a DIFFERENT fetched order => reference-conflict", () => {
    const orderA = order({ name: "#2001", amount: 90, createdAt: "2026-07-10T00:00:00Z" });
    const orderB = order({ name: "#9999", amount: 999, createdAt: "2026-01-01T00:00:00Z" });
    // Belongs (by DocNumber) to orderB, but amount/date land it as a
    // plausible match for orderA instead.
    const sr = salesReceipt({ DocNumber: "9999", amount: 92, TxnDate: "2026-07-11" });

    const { findings } = matchRevenue(
      [normalizeOrder(orderA), normalizeOrder(orderB)],
      [normalizeSalesReceipt(sr)],
    );

    const conflictFinding = findingFor(findings, "#2001");
    assert.equal(conflictFinding.type, "reference-conflict");
    assert.equal(revenueFindingImpact(conflictFinding), 90);

    // The QBO record was claimed by orderA's conflict match, so orderB (its
    // "rightful" reference owner) has nothing left to match against.
    const orderBFinding = findingFor(findings, "#9999");
    assert.equal(orderBFinding.type, "missing-order");
  });

  test("invoices participate in revenue matching the same way sales receipts do", () => {
    const o = order({ name: "#3001", amount: 120 });
    const inv = invoice({ DocNumber: "3001", amount: 120 });
    const { findings } = matchRevenue([normalizeOrder(o)], [normalizeInvoice(inv)]);
    const finding = findingFor(findings, "#3001");
    assert.equal(finding.type, "matched");
  });

  test("unclaimed QuickBooks revenue is reported separately, not as a finding", () => {
    const o = order({ name: "#4001", amount: 10 });
    const srMatched = salesReceipt({ DocNumber: "4001", amount: 10 });
    const srExtra = salesReceipt({ DocNumber: "4002", amount: 500, TxnDate: "2026-01-01" });
    const { unmatchedQboRevenue } = matchRevenue(
      [normalizeOrder(o)],
      [normalizeSalesReceipt(srMatched), normalizeSalesReceipt(srExtra)],
    );
    assert.equal(unmatchedQboRevenue.length, 1);
    assert.equal(unmatchedQboRevenue[0].nativeId, srExtra.Id);
  });
});

// --- Settlement matching -------------------------------------------------

describe("matchSettlement", () => {
  const empty = new Map<string, NormalizedTransaction>();

  test("payout with an exact-amount deposit within the window => matched, zero impact", () => {
    const p = payout({ amount: 500, issuedAt: "2026-07-01T00:00:00Z" });
    const d = deposit({ amount: 500, TxnDate: "2026-07-02" });
    const findings = matchSettlement([normalizePayout(p)], [normalizeDeposit(d)], empty);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "matched");
    assert.equal(settlementFindingImpact(findings[0]), 0);
  });

  test("payout with a same-window deposit for the wrong amount => amount-mismatch", () => {
    const p = payout({ amount: 300, issuedAt: "2026-07-01T00:00:00Z" });
    const d = deposit({ amount: 280, TxnDate: "2026-07-02" });
    const findings = matchSettlement([normalizePayout(p)], [normalizeDeposit(d)], empty);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "amount-mismatch");
    assert.equal(settlementFindingImpact(findings[0]), 20);
  });

  test("payout with no deposit in the settlement window => not-deposited, full amount at risk", () => {
    const p = payout({ amount: 150, issuedAt: "2026-07-01T00:00:00Z" });
    const findings = matchSettlement([normalizePayout(p)], [], empty);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "not-deposited");
    assert.equal(settlementFindingImpact(findings[0]), 150);
  });

  test("a deposit with no corresponding payout at all => unexplained-deposit, zero impact (informational)", () => {
    const d = deposit({ amount: 75, TxnDate: "2026-07-01" });
    const findings = matchSettlement([], [normalizeDeposit(d)], empty);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "unexplained-deposit");
    assert.equal(settlementFindingImpact(findings[0]), 0);
  });

  test("a deposit dated BEFORE its payout is not eligible to match it", () => {
    const p = payout({ amount: 100, issuedAt: "2026-07-05T00:00:00Z" });
    const d = deposit({ amount: 100, TxnDate: "2026-07-04" }); // one day earlier
    const findings = matchSettlement([normalizePayout(p)], [normalizeDeposit(d)], empty);
    // The payout should NOT have matched (finds no eligible candidate), and
    // the deposit should surface separately as unexplained.
    const payoutFinding = findings.find((f) => f.payout !== null);
    const depositFinding = findings.find((f) => f.deposit !== null && f.payout === null);
    assert.equal(payoutFinding?.type, "not-deposited");
    assert.equal(depositFinding?.type, "unexplained-deposit");
  });
});

// --- Full orchestration, including deposit -> payment LinkedTxn tracing --

describe("reconcile (full orchestration)", () => {
  test("wires normalizers and both matchers together, and resolves a deposit's linked payment", () => {
    const o = order({ name: "#5001", amount: 500, createdAt: "2026-07-01T00:00:00Z" });
    const pmt = payment({ amount: 500, TxnDate: "2026-07-01" });
    const p = payout({ amount: 500, issuedAt: "2026-07-01T00:00:00Z" });
    const d = deposit({
      amount: 500,
      TxnDate: "2026-07-02",
      Line: [{ Amount: 500, LinkedTxn: [{ TxnId: pmt.Id, TxnType: "Payment" }] }],
    });

    const result = reconcile({
      orders: [o],
      payouts: [p],
      salesReceipts: [],
      invoices: [],
      payments: [pmt],
      deposits: [d],
    });

    // Revenue side: the order has no matching sales receipt/invoice at all
    // (the Payment isn't matched against orders directly, per the module's
    // documented bucket model), so it's a missing-order finding.
    const revenueFinding = findingFor(result.revenue.findings, "#5001");
    assert.equal(revenueFinding.type, "missing-order");

    // Settlement side: payout matches the deposit, and the deposit's
    // LinkedTxn resolves back to the Payment record.
    assert.equal(result.settlement.length, 1);
    assert.equal(result.settlement[0].type, "matched");
    assert.equal(result.settlement[0].linkedRevenue.length, 1);
    assert.equal(result.settlement[0].linkedRevenue[0].nativeId, pmt.Id);
  });
});
