import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import {
  FULL_AUDIT_INTRO_PRICE,
  FULL_AUDIT_PLAN_INTRO,
  FULL_AUDIT_PLAN_REGULAR,
  FULL_AUDIT_REGULAR_PRICE,
} from "./billing-shared";

// A one-time purchase that unlocks the itemized findings on the
// reconciliation report. The free preview (no purchase) still shows the
// issue count and total dollar impact — see app/routes/app._index.tsx's
// loader for the gate and its action for where the purchase is made.
//
// Two plans exist because pricing is tiered: the first 50 audits sold
// (tracked in billing.server.ts) go for FULL_AUDIT_INTRO_PRICE, after
// which new purchases move to FULL_AUDIT_REGULAR_PRICE. The Billing API
// prices a plan statically by name, so tiering requires two named plans
// rather than one plan with a variable amount.

// Real card charges must never happen outside of a genuine production
// deploy — this must read `false` for the App Store submission build.
// NODE_ENV is "production" in a deployed build and "development" under
// `shopify app dev`, so this defaults safely without anyone needing to
// remember to flip a hardcoded flag.
export const BILLING_IS_TEST = process.env.NODE_ENV !== "production";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [FULL_AUDIT_PLAN_INTRO]: {
      amount: FULL_AUDIT_INTRO_PRICE,
      currencyCode: "USD",
      interval: BillingInterval.OneTime,
    },
    [FULL_AUDIT_PLAN_REGULAR]: {
      amount: FULL_AUDIT_REGULAR_PRICE,
      currencyCode: "USD",
      interval: BillingInterval.OneTime,
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
