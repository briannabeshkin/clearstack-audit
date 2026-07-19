import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { buildAuthorizationUrl } from "../qbo.server";

// Returns { authorizationUrl } as JSON instead of issuing a redirect. This
// route is meant to be called via client-side fetch() (see app.settings.tsx)
// rather than a plain link navigation, specifically so the caller can attach
// the `ngrok-skip-browser-warning` header — a browser navigating here
// directly (an <a>/target="_blank" click) can't carry custom headers, so it
// would hit ngrok's free-tier interstitial before ever reaching this loader.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) {
    throw new Response("Missing shop parameter", { status: 400 });
  }

  // This route is opened outside the embedded admin iframe, so it can't
  // rely on authenticate.admin's embedded session-token flow. Instead it
  // just confirms the shop actually has this app installed before handing
  // out an Intuit authorization link.
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) {
    throw new Response("Unknown shop", { status: 400 });
  }

  try {
    return { authorizationUrl: buildAuthorizationUrl(shop) };
  } catch {
    throw new Response(
      "QuickBooks integration is not configured yet (missing QBO_CLIENT_ID/QBO_CLIENT_SECRET/QBO_REDIRECT_URI).",
      { status: 500 },
    );
  }
};
