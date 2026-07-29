import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

// DATABASE_URL is injected by the Neon-Vercel integration and gets
// resynced automatically (e.g. whenever the underlying role's password
// rotates), so there's no way to hand-append query params to it in the
// Vercel dashboard — anything typed there is liable to get overwritten,
// and a second manually-created env var would silently go stale the next
// time Neon rotates credentials. Appending the params here instead means
// they're always applied to whatever value DATABASE_URL currently holds,
// in every environment, with nothing to keep in sync by hand. This is
// Prisma's own documented workaround for integration-managed connection
// strings (see https://www.prisma.io/docs and Neon's Vercel integration
// docs, which both call this out explicitly).
//
// pgbouncer=true: required any time Prisma talks to Postgres through a
// transaction-mode pooler (Neon's built-in PgBouncer, which is what the
// pooled DATABASE_URL routes through). Without it, Prisma uses prepared
// statements that PgBouncer's transaction pooling mode doesn't support —
// that mismatch is what was surfacing in production as
// PrismaClientInitializationError under real (concurrent) traffic, even
// though a single request locally worked fine.
// connection_limit=1: caps how many connections a single PrismaClient
// opens. Serverless can have several function instances warm at once, each
// with its own cached client (see below) — without a low per-client limit,
// a handful of concurrent instances can still exhaust Neon's connection
// ceiling even when going through the pooler.
function withPoolerParams(url: string | undefined): string | undefined {
  if (!url) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("pgbouncer")) {
    parsed.searchParams.set("pgbouncer", "true");
  }
  if (!parsed.searchParams.has("connection_limit")) {
    parsed.searchParams.set("connection_limit", "1");
  }
  return parsed.toString();
}

// Cache the client on `global` in every environment, not just dev.
//
// The old `if (NODE_ENV !== "production")` guard here only existed to dodge
// Vite HMR creating a fresh PrismaClient (and fresh connection pool) on
// every hot reload in local dev — but gating it to non-production means
// production got NO caching at all, which is backwards for Vercel's
// serverless model. A warm Lambda container reuses its module scope across
// invocations, so without the global cache, anything that causes this
// module to be re-evaluated (bundler/route-splitting quirks, concurrent
// cold starts, etc.) spins up another PrismaClient — and each PrismaClient
// opens its own connection pool. Against Neon's low concurrent-connection
// ceiling, a handful of those stacking up under real traffic is exactly
// what surfaces as PrismaClientInitializationError: not one client failing
// to connect, but too many separate pools competing for too few slots.
// Caching unconditionally means at most one client (and one pool) per warm
// container, in every environment.
if (!global.prismaGlobal) {
  global.prismaGlobal = new PrismaClient({
    datasources: {
      db: {
        url: withPoolerParams(process.env.DATABASE_URL),
      },
    },
  });
}

const prisma = global.prismaGlobal;

export default prisma;
