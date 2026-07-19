import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { exchangeCodeForTokens, saveConnection, verifyState } from "../qbo.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return { status: "denied" as const };
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  if (!code || !state || !realmId) {
    return { status: "error" as const, message: "Missing code, state, or realmId." };
  }

  let shop: string;
  try {
    shop = verifyState(state);
  } catch {
    return { status: "error" as const, message: "Invalid state parameter." };
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveConnection(shop, realmId, tokens);
  } catch {
    return { status: "error" as const, message: "Failed to exchange the authorization code." };
  }

  return { status: "connected" as const };
};

export default function QuickBooksCallback() {
  const data = useLoaderData<typeof loader>();

  const heading =
    data.status === "connected"
      ? "QuickBooks connected"
      : data.status === "denied"
        ? "Connection cancelled"
        : "Connection failed";

  const message =
    data.status === "connected"
      ? "Your QuickBooks Online account is now connected. You can close this tab and return to Shopify."
      : data.status === "denied"
        ? "You cancelled the QuickBooks authorization. You can close this tab and try again from the Settings page."
        : data.message;

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
      <h1>{heading}</h1>
      <p>{message}</p>
      {data.status === "connected" && (
        <script
          dangerouslySetInnerHTML={{
            __html: `if (window.opener) { try { window.opener.location.reload(); } catch (e) {} }`,
          }}
        />
      )}
    </div>
  );
}
