// Pure extraction of the reconciliation report's billing/visibility gate —
// deliberately isolated from app._index.tsx's loader (which mixes this
// decision in with data fetching, Prisma calls, and Shopify's billing API)
// so the exact lock/unlock/clean/incomplete branching can be unit tested
// without needing to mock authenticate.admin(), Prisma, or any network
// call. The loader calls this function and switches on its result; the
// branching logic itself lives only here.
//
// Order matters and is deliberate, mirroring the loader's original
// (pre-extraction) if-chain exactly:
//   1. Incomplete data always wins — never claim a clean or locked/unlocked
//      state built on data we know is partial.
//   2. Zero issues means nothing to sell — "clean" short-circuits before
//      billing is even considered, regardless of purchase history.
//   3. Only once there's something to show does purchase status decide
//      locked vs. unlocked.

export type ReportState = "incomplete" | "clean" | "locked" | "unlocked";

export interface ReportStateInput {
  dataIncomplete: boolean;
  issueCount: number;
  hasActivePayment: boolean;
}

export function determineReportState({
  dataIncomplete,
  issueCount,
  hasActivePayment,
}: ReportStateInput): ReportState {
  if (dataIncomplete) return "incomplete";
  if (issueCount === 0) return "clean";
  if (!hasActivePayment) return "locked";
  return "unlocked";
}
