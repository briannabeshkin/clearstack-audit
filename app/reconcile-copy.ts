// Turns a RevenueFinding/SettlementFinding into merchant-facing copy: a
// headline, a plain-English explanation, a severity tone for the UI, and the
// dollar amount to show alongside it. This is intentionally separate from
// reconcile.ts — that module's `detail` strings are precise/technical
// traces; this is the "written for a merchant, not an accountant" layer on
// top, and it's meant to also run client-side (hence no `.server` suffix on
// either file).
import type {
  NormalizedTransaction,
  RevenueFinding,
  SettlementFinding,
} from "./reconcile";
import { revenueFindingImpact, settlementFindingImpact } from "./reconcile";

export type FindingTone = "critical" | "warning" | "info" | "success";

export interface FindingDisplay {
  headline: string;
  explanation: string;
  tone: FindingTone;
  amount: number;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export function formatDate(dateOnly: string): string {
  return dateFormatter.format(new Date(`${dateOnly}T00:00:00Z`));
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function describeRecord(record: NormalizedTransaction): string {
  return record.displayReference ?? `on ${formatDate(record.date)}`;
}

export function describeRevenueFinding(finding: RevenueFinding): FindingDisplay {
  const { order } = finding;
  const amountStr = formatMoney(order.amount, order.currency);
  const dateStr = formatDate(order.date);
  const impact = revenueFindingImpact(finding);

  switch (finding.type) {
    case "missing-order":
      return {
        headline: `Order ${order.displayReference} — ${dateStr}`,
        explanation: `This order was paid in Shopify, but there's no matching sales receipt or invoice in QuickBooks. Until it's recorded, this revenue won't show up in your books.`,
        tone: "critical",
        amount: impact,
      };

    case "duplicate": {
      const count = finding.matches.length;
      return {
        headline: `Order ${order.displayReference} — ${dateStr}, recorded ${count}× in QuickBooks`,
        explanation: `This order matches ${count} separate QuickBooks records that all share the same reference number — usually a sign it got synced twice. That overstates your revenue by ${formatMoney(impact, order.currency)}.`,
        tone: "critical",
        amount: impact,
      };
    }

    case "reference-conflict": {
      const other = finding.matches[0];
      return {
        headline: `Order ${order.displayReference} — ${dateStr}, possible duplicate`,
        explanation: `A QuickBooks record (${other ? describeRecord(other) : "unreferenced"}) matches this order's amount and date, but its own reference number points to a different order. Could be a coincidence, but this pattern often means an order got re-synced under the wrong number — worth a quick check.`,
        tone: "warning",
        amount: impact,
      };
    }

    case "matched-variance": {
      const match = finding.matches[0];
      // Impact is 0 by design here (see revenueFindingImpact) — it's not
      // lost or overstated revenue, so it doesn't belong in the headline
      // total. The badge still shows the actual gap, not the (zero) impact,
      // same reasoning as the unexplained-deposit case below.
      const variance = match ? Math.abs(order.amount - match.amount) : 0;
      const matchedByReference = Boolean(match?.reference && match.reference === order.reference);
      return {
        headline: `Order ${order.displayReference} — ${dateStr}, amounts differ`,
        explanation: `This order is recorded in QuickBooks${match ? ` (${describeRecord(match)})` : ""} for ${match ? formatMoney(match.amount, match.currency) : "a different amount"} instead of ${amountStr} — a ${formatMoney(variance, order.currency)} difference.${matchedByReference ? "" : " It was matched by amount and date rather than a reference number, so it's a little less certain."} Likely tax, shipping, or a discount calculated differently between Shopify and QuickBooks — not missing revenue, but worth a glance if the gap looks bigger than that.`,
        tone: "warning",
        amount: variance,
      };
    }

    case "matched-fuzzy": {
      const match = finding.matches[0];
      return {
        headline: `Order ${order.displayReference} — ${dateStr}, matched by amount and date`,
        explanation: `We matched this order to a QuickBooks record${match ? ` (${describeRecord(match)})` : ""} because the amount and date line up, but the QuickBooks side has no reference number to confirm it's the right one. Probably fine — just flagging it so you can glance at it.`,
        tone: "info",
        amount: order.amount,
      };
    }

    case "matched":
      return {
        headline: `Order ${order.displayReference} — ${dateStr}`,
        explanation: `Matches QuickBooks cleanly (${amountStr}).`,
        tone: "success",
        amount: 0,
      };
  }
}

export function describeSettlementFinding(finding: SettlementFinding): FindingDisplay {
  const impact = settlementFindingImpact(finding);

  switch (finding.type) {
    case "not-deposited": {
      const payout = finding.payout!;
      return {
        headline: `Payout issued ${formatDate(payout.date)} — ${formatMoney(payout.amount, payout.currency)}`,
        explanation: `Shopify issued this payout, but there's no matching deposit in QuickBooks within 3 days. Either the deposit hasn't been entered yet, or it's missing from your books.`,
        tone: "critical",
        amount: impact,
      };
    }

    case "amount-mismatch": {
      const payout = finding.payout!;
      const deposit = finding.deposit!;
      return {
        headline: `Payout issued ${formatDate(payout.date)} — ${formatMoney(payout.amount, payout.currency)} vs. deposit of ${formatMoney(deposit.amount, deposit.currency)}`,
        explanation: `The closest QuickBooks deposit (${formatDate(deposit.date)}) is off by ${formatMoney(impact, payout.currency)}. Worth checking for a missing fee adjustment or a partial deposit.`,
        tone: "warning",
        amount: impact,
      };
    }

    case "unexplained-deposit": {
      const deposit = finding.deposit!;
      // Impact is always 0 here by design (see settlementFindingImpact) —
      // it doesn't count toward the headline total. The badge still shows
      // the deposit's real amount for context, not the (zero) impact.
      return {
        headline: `Deposit on ${formatDate(deposit.date)} — ${formatMoney(deposit.amount, deposit.currency)}, no matching payout`,
        explanation: `This deposit doesn't correspond to any Shopify payout we found. It's probably unrelated business activity — another sales channel, an owner contribution, and so on — but worth a glance if the amount looks familiar.`,
        tone: "info",
        amount: deposit.amount,
      };
    }

    case "matched": {
      const payout = finding.payout!;
      return {
        headline: `Payout issued ${formatDate(payout.date)} — ${formatMoney(payout.amount, payout.currency)}`,
        explanation: `Matches a QuickBooks deposit cleanly.`,
        tone: "success",
        amount: 0,
      };
    }
  }
}
