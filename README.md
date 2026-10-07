# ClearStack Audit

ClearStack is a read-only Shopify app that helps merchants identify discrepancies between their Shopify and QuickBooks data.

I built ClearStack after researching problems merchants experienced when changes to accounting integrations left orders and financial records inconsistent across systems.

## What it does

ClearStack connects Shopify and QuickBooks and compares financial records across the two systems to surface potential reconciliation issues, including:

- Missing or unmatched transactions
- Amount mismatches
- Duplicate or conflicting records
- Payout and deposit discrepancies

Each finding includes the relevant transaction information, dollar impact, confidence level, and a plain-English explanation of what appears to be wrong.

## Product approach

I designed ClearStack as an audit layer rather than another synchronization tool.

The app is intentionally read-only so merchants can investigate discrepancies without giving it permission to modify their accounting records.

The reconciliation engine uses deterministic logic rather than an LLM. Financial discrepancies need to be reproducible, so the same records should produce the same result every time.

ClearStack normalizes transactions across Shopify and QuickBooks and matches them using signals including transaction references, amounts, dates, and relationships between records. Matching rules use different tolerance levels depending on the strength of the available evidence.

This allows ClearStack to distinguish high-confidence discrepancies from transactions that may simply require further review.

## Built with

- TypeScript
- React + React Router
- Shopify APIs / GraphQL
- QuickBooks Online API + OAuth
- Prisma
- PostgreSQL (Neon)
- Vercel

## Development

I built ClearStack using AI-assisted development tools while defining the product behavior, reconciliation approach, architecture, and user experience.

The project includes the full Shopify and QuickBooks connection flows, cross-system reconciliation logic, merchant-facing reporting, billing, and Shopify privacy/compliance handling.

## Status

Deployed and submitted to the Shopify App Store for review.
