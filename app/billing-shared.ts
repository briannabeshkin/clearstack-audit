// Pricing constants and types for the one-time Full Audit purchase — pure
// values, no imports. Split out from billing.server.ts (which needs the
// Prisma client to count sold audits) specifically so the report page's
// component can reference the price/plan-name constants without pulling a
// Node-only module into the client bundle. React Router treats any
// `.server.ts` file as excluded from the client bundle and hard-errors if
// client-rendered code imports a value from one — billing.server.ts must
// keep that suffix (it touches the database), so this file exists to hold
// everything that's safe, and needs, to be shared with the UI.
//
// The first FULL_AUDIT_INTRO_LIMIT audits sold, across all shops, get the
// intro price; once that many have sold, new purchases are offered at the
// regular price. A shop that already purchased keeps whatever they paid —
// this only affects which plan is *offered* to shops that haven't bought
// yet. Two separate named plans exist (rather than one plan with a
// variable amount) because the Shopify Billing API prices are fixed per
// plan name, defined statically in shopify.server.ts.
export const FULL_AUDIT_PLAN_INTRO = "Full audit (intro)";
export const FULL_AUDIT_PLAN_REGULAR = "Full audit";
export const FULL_AUDIT_INTRO_PRICE = 49;
export const FULL_AUDIT_REGULAR_PRICE = 79;
export const FULL_AUDIT_INTRO_LIMIT = 50;

// Typed as the literal union (not `string`) so `billing.request({ plan })`
// — which requires a key of the `billing` config in shopify.server.ts —
// accepts it directly without a cast.
export type FullAuditPlanName = typeof FULL_AUDIT_PLAN_INTRO | typeof FULL_AUDIT_PLAN_REGULAR;

export interface CurrentPlan {
  name: FullAuditPlanName;
  price: number;
  isIntro: boolean;
}
