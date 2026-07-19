import db from "./db.server";
import {
  FULL_AUDIT_INTRO_LIMIT,
  FULL_AUDIT_INTRO_PRICE,
  FULL_AUDIT_PLAN_INTRO,
  FULL_AUDIT_PLAN_REGULAR,
  FULL_AUDIT_REGULAR_PRICE,
  type CurrentPlan,
} from "./billing-shared";

// Genuinely server-only: everything here touches the database. Pricing
// constants and types live in billing-shared.ts instead, so route
// components can reference them without pulling Prisma into the client
// bundle — see the comment at the top of that file for why.

// How many audits have sold so far, across all shops.
export async function getAuditsSoldCount(): Promise<number> {
  return db.auditPurchase.count();
}

// The plan a shop should be offered right now, based on how many have sold
// so far.
//
// This is a read-then-decide check, not an atomic reservation — if two
// shops purchase within moments of each other right around the 50th sale,
// it's possible both see the intro price. That's an acceptable outcome at
// this app's scale (worst case, one or two extra shops get $49 instead of
// $79), and not worth adding transactional/locking complexity for.
export async function getCurrentPlan(): Promise<CurrentPlan> {
  const sold = await getAuditsSoldCount();
  if (sold < FULL_AUDIT_INTRO_LIMIT) {
    return { name: FULL_AUDIT_PLAN_INTRO, price: FULL_AUDIT_INTRO_PRICE, isIntro: true };
  }
  return { name: FULL_AUDIT_PLAN_REGULAR, price: FULL_AUDIT_REGULAR_PRICE, isIntro: false };
}

// Records a completed purchase the first time we see it, keyed by
// Shopify's own charge id. The report loader calls billing.check() on
// every page load, so without this dedupe a shop that paid once would get
// counted again on every subsequent visit.
export async function recordPurchaseIfNew(
  shop: string,
  chargeId: string,
  amount: number,
): Promise<void> {
  const existing = await db.auditPurchase.findUnique({ where: { chargeId } });
  if (existing) return;

  try {
    await db.auditPurchase.create({ data: { shop, chargeId, amount } });
  } catch {
    // Unique constraint race: another concurrent request already recorded
    // this exact charge in the moment between our check and our insert.
    // Fine to ignore — the goal was just to avoid double-counting, and it
    // didn't get double-counted.
  }
}
