import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

// --- Orders --------------------------------------------------------------

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface OrderRow {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  totalPriceSet: {
    shopMoney: MoneyV2;
  };
  // Requires protected customer data access — see
  // https://shopify.dev/docs/apps/launch/protected-customer-data. Used as a
  // tiebreaker when reconciling orders against QuickBooks records (e.g. two
  // orders with the same amount on the same day).
  customer: { displayName: string } | null;
}

/**
 * Throws on any GraphQL-level error (missing scope, protected-data access
 * not yet approved, etc.) — callers decide how to degrade (see the
 * `safe()`-style wrapping in app.quickbooks.tsx and the try/catch in
 * app._index.tsx's loader).
 */
export async function fetchRecentOrders(
  graphql: AdminGraphqlClient,
): Promise<OrderRow[]> {
  const response = await graphql(
    `#graphql
      query RecentOrders {
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                displayName
              }
            }
          }
        }
      }`,
  );
  const { data } = await response.json();
  return data?.orders?.edges.map(({ node }: { node: OrderRow }) => node) ?? [];
}

// --- Payouts ---------------------------------------------------------------

export interface PayoutRow {
  id: string;
  issuedAt: string;
  status: string;
  net: MoneyV2;
  summary: {
    chargesGross: MoneyV2;
    chargesFee: MoneyV2;
    refundsFeeGross: MoneyV2;
    adjustmentsGross: MoneyV2;
    adjustmentsFee: MoneyV2;
  };
}

export interface PayoutsResult {
  payouts: PayoutRow[];
  // Dev stores, and stores that never set up Shopify Payments, legitimately
  // have no payouts account — that's distinct from a fetch failure, so it's
  // reported separately rather than folded into an empty array.
  hasPayoutsAccount: boolean;
}

export async function fetchRecentPayouts(
  graphql: AdminGraphqlClient,
): Promise<PayoutsResult> {
  const response = await graphql(
    `#graphql
      query RecentPayouts {
        shopifyPaymentsAccount {
          payouts(first: 25, sortKey: ISSUED_AT, reverse: true) {
            edges {
              node {
                id
                issuedAt
                status
                net {
                  amount
                  currencyCode
                }
                summary {
                  chargesGross {
                    amount
                    currencyCode
                  }
                  chargesFee {
                    amount
                    currencyCode
                  }
                  refundsFeeGross {
                    amount
                    currencyCode
                  }
                  adjustmentsGross {
                    amount
                    currencyCode
                  }
                  adjustmentsFee {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }`,
  );
  const { data } = await response.json();
  const hasPayoutsAccount = data?.shopifyPaymentsAccount != null;
  const payouts =
    data?.shopifyPaymentsAccount?.payouts?.edges.map(
      ({ node }: { node: PayoutRow }) => node,
    ) ?? [];
  return { payouts, hasPayoutsAccount };
}
