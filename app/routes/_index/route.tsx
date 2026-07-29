import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Any of these indicate the request is coming from inside the Shopify
  // admin — an embedded load of an already-installed app — rather than a
  // standalone visit to this public marketing/login page. Hand off to
  // /app immediately, which does the actual session verification via
  // authenticate.admin(). `host` (the base64 admin URL) is what Shopify
  // reliably sends on every embedded load via App Bridge's session-token
  // flow; a bare `shop` param isn't guaranteed to be present on its own,
  // which is what let embedded loads fall through to this page instead of
  // routing straight to the report.
  if (
    url.searchParams.get("host") ||
    url.searchParams.get("shop") ||
    url.searchParams.get("embedded")
  ) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

// Small, monochrome, stroke-based icons matching Polaris's own icon style
// (24x24-ish grid, currentColor, ~1.5 stroke) — kept as plain inline SVG
// rather than pulling in the s-icon web component or a full icon library,
// since this route renders outside the embedded admin shell where App
// Bridge (and its custom elements) aren't loaded.
function MissingOrderIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M9 4h10l5 5v19a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M19 4v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="11" y1="17" x2="21" y2="17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2.5 2.5" />
      <line x1="11" y1="22" x2="17" y2="22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M11 5h11a2 2 0 0 1 2 2v18"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="7" y="9" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10.5" y1="15" x2="17.5" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10.5" y1="19" x2="17.5" y2="19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PayoutIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M5 12l11-7 11 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="4" y1="12" x2="28" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8" y1="12" x2="8" y2="23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="16" y1="12" x2="16" y2="23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="24" y1="12" x2="24" y2="23" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="4" y1="27" x2="28" y2="27" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const VALUE_PROPS = [
  {
    icon: MissingOrderIcon,
    title: "Missing orders",
    text: "Orders paid in Shopify with no matching record in QuickBooks, so they never quietly fall out of your books.",
  },
  {
    icon: DuplicateIcon,
    title: "Duplicates and conflicts",
    text: "Orders recorded more than once, or QuickBooks reference numbers that don’t line up.",
  },
  {
    icon: PayoutIcon,
    title: "Payout mismatches",
    text: "Shopify payouts with no matching QuickBooks deposit, or a deposit for the wrong amount.",
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      {/*
        This page should never legitimately render inside the Shopify admin
        iframe — any real embedded load carries host/shop/embedded and gets
        redirected to /app by the loader above. If it DOES end up rendering
        here while framed (a known shopify-app-react-router template issue:
        github.com/Shopify/shopify-app-template-react-router/issues/194 —
        an iframe reload or a failed session-token bounce can land back on
        this route without those params), submitting the login form below
        would POST to /auth/login and try to redirect to accounts.shopify.com
        *inside* the iframe, which Shopify blocks ("refused to connect").
        Busting out to a top-level navigation first means that OAuth/login
        flow — and the loader's own /app redirect on reload — happens
        outside the iframe, where it's actually allowed to work.
      */}
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html:
            "if (window.top !== window.self) { window.top.location.href = window.location.href; }",
        }}
      />

      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <span className={styles.wordmark}>ClearStack Audit</span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <p className={styles.kicker}>Shopify &middot; QuickBooks Online</p>
          <h1 className={styles.heading}>Know before your bookkeeper does.</h1>
          <p className={styles.subhead}>
            ClearStack Audit cross-checks your Shopify orders and payouts against QuickBooks
            Online and flags what doesn&apos;t line up &mdash; in plain English, with dollar
            amounts.
          </p>
          <p className={styles.subheadSecondary}>
            Read-only. It never writes anything back to either system.
          </p>
        </section>

        <section className={styles.cards} aria-label="What ClearStack Audit checks">
          {VALUE_PROPS.map(({ icon: Icon, title, text }) => (
            <article className={styles.card} key={title}>
              <span className={styles.cardIcon}>
                <Icon />
              </span>
              <h2 className={styles.cardTitle}>{title}</h2>
              <p className={styles.cardText}>{text}</p>
            </article>
          ))}
        </section>

        {showForm && (
          <section className={styles.loginCard} aria-label="Log in">
            <div className={styles.loginText}>
              <h2 className={styles.loginHeading}>Already installed?</h2>
              <p className={styles.loginSubtext}>
                Log in with your shop domain to open your reconciliation report.
              </p>
            </div>
            <Form className={styles.form} method="post" action="/auth/login">
              <label className={styles.label} htmlFor="shop-domain">
                Shop domain
              </label>
              <div className={styles.fieldRow}>
                <input
                  className={styles.input}
                  id="shop-domain"
                  type="text"
                  name="shop"
                  placeholder="my-shop-domain.myshopify.com"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className={styles.button} type="submit">
                  Log in
                </button>
              </div>
            </Form>
          </section>
        )}
      </main>

      <footer className={styles.footer}>
        <p className={styles.footerText}>
          &copy; {new Date().getFullYear()} ClearStack Audit &middot;{" "}
          <a className={styles.footerLink} href="/privacy">
            Privacy Policy
          </a>
        </p>
      </footer>
    </div>
  );
}
