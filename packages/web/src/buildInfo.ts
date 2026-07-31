/**
 * The revision this SPA bundle was built from, stamped by vite.config.ts at build time (ADR-027).
 *
 * Distinct from the version /api/health reports, which is resolved by the *server* at runtime. They
 * cannot diverge in a published install — the SPA ships prebuilt inside the CLI bundle — but they do
 * diverge when an installed service is still running an older build, or in development against a
 * stale `pnpm build`. That mismatch is the single most useful thing the About page can tell you, so
 * it is surfaced rather than hidden.
 */
declare const __BUILD_VERSION__: string;

export const BUILD_VERSION: string = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "unknown";
