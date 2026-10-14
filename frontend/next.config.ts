import type { NextConfig } from "next";

// Response headers for every page and API route. They apply to the production build only:
// the development server needs eval and websockets for hot reload, which a strict policy
// would block.
//
// Content-Security-Policy: scripts are same-origin only, plus inline scripts (Next.js
// inlines its hydration data; a per-request nonce would make every page dynamic, so the
// inline allowance is the documented trade-off), plus WebAssembly (PDF.js image decoders).
// PDF.js runs in a same-origin worker (or a blob: worker). Nothing is loaded from another
// origin, nothing may frame the app, and forms and base URLs are same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Ignored over plain http; honoured once the site is served over https.
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
