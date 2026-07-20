import { vercelPreset } from "@vercel/react-router/vite";
import type { Config } from "@react-router/dev/config";

// Enables Vercel Functions for this app's server-rendered routes (all of
// them — nothing here uses SPA mode), plus per-route function config and
// accurate deployment summaries in the Vercel dashboard. Without this
// preset, `react-router build` still produces a working server build, but
// Vercel has to guess at how to run it rather than deploying it the way
// it's meant to run.
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
