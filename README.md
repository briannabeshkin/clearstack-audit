# ClearStack Audit

ClearStack is a read-only Shopify app that helps merchants identify discrepancies between their Shopify and QuickBooks data.

I built it after researching problems merchants experienced when changes to accounting integrations left orders and financial records inconsistent across systems.

## What it does

ClearStack connects Shopify and QuickBooks data and flags potential reconciliation issues including:

- Missing orders
- Duplicate or conflicting records
- Amount mismatches
- Payout gaps

Each issue includes the relevant transaction information, confidence level, and a plain-English explanation.

## Product approach

I designed ClearStack as an audit layer rather than another synchronization tool.

The app is intentionally read-only so merchants can investigate discrepancies without giving the product permission to modify their accounting records.

For reconciliation, I use deterministic matching logic rather than an LLM. Financial discrepancies need to be reproducible, so the same records should produce the same result every time.

AI is instead used after a discrepancy has been identified to explain the issue to the merchant in plain English.

The matching system also uses confidence tiers to distinguish clear discrepancies from records that may require review.

## Built with

- TypeScript
- React Router
- Shopify APIs
- QuickBooks API
- PostgreSQL / Prisma
- LLM API for discrepancy explanations

## Status

Submitted to the Shopify App Store for review.
