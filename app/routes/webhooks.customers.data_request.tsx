import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR compliance webhook. Fired when a customer (or Shopify, on
// their behalf) requests the data a store's apps hold about them.
//
// This app never stores customer-level data: the only rows it keeps are
// shop-level QuickBooks OAuth tokens (QuickBooksConnection) and the Shopify
// session (Session), neither of which reference a specific customer. Every
// order/customer record this app reads comes live from the Shopify and
// QuickBooks APIs on each report load and is never persisted. So there's
// nothing customer-specific to compile or hand over here — acknowledging
// the webhook is the correct, complete response.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: payload.customer?.id,
  });

  return new Response();
};
