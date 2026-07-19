import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR compliance webhook. Fired ~10 days after a customer
// requests erasure, instructing apps to delete that customer's data.
//
// Same reasoning as customers/data_request: this app doesn't persist
// customer-level data anywhere (no customer id, name, email, or order
// detail is ever written to our database — only shop-level QuickBooks
// tokens and the Shopify session). There's nothing to redact here, so
// acknowledging the webhook is the correct, complete response.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: payload.customer?.id,
  });

  return new Response();
};
