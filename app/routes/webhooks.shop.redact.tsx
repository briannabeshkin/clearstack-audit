import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { disconnectShop } from "../qbo.server";
import db from "../db.server";

// Mandatory GDPR compliance webhook. Fires 48 hours after a shop uninstalls
// the app, instructing apps to delete all data associated with that shop.
//
// This app's only shop-scoped storage is the Shopify session (Session) and
// the QuickBooks OAuth connection (QuickBooksConnection) — everything else
// (orders, payouts, sales receipts, deposits, and so on) is read live from
// the Shopify and QuickBooks APIs on each report load and never persisted.
// disconnectShop() best-effort revokes the QuickBooks refresh token at
// Intuit before deleting the row, so the token doesn't just go unused, it's
// actually invalidated.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await disconnectShop(shop);
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
