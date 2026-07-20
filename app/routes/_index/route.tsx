import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Know before your bookkeeper does.</h1>
        <p className={styles.text}>
          ClearStack Audit cross-checks your Shopify orders and payouts against QuickBooks
          Online and flags what doesn&apos;t line up — in plain English, with dollar amounts.
          Read-only: it never writes anything back to either system.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Missing orders.</strong> Orders paid in Shopify with no matching record in
            QuickBooks, so they never quietly fall out of your books.
          </li>
          <li>
            <strong>Duplicates and conflicts.</strong> Orders recorded more than once, or QuickBooks
            reference numbers that don&apos;t line up.
          </li>
          <li>
            <strong>Payout mismatches.</strong> Shopify payouts with no matching QuickBooks deposit,
            or a deposit for the wrong amount.
          </li>
        </ul>
      </div>
    </div>
  );
}
