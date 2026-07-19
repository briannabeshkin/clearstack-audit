import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { disconnectShop } from "../qbo.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Revoke and drop the QuickBooks connection right away rather than
  // waiting on shop/redact (which Shopify sends up to 48 hours later) — no
  // reason to leave a live refresh token sitting around for an app the
  // merchant just uninstalled.
  await disconnectShop(shop);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
