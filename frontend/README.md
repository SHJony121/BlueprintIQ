# BlueprintIQ frontend (Phase 2A)

Local Next.js + TypeScript + Tailwind interface for the BlueprintIQ backend. Done so far: **F0** (scaffold, PDF.js worker check), **F1** (server-side proxy `POST /api/inspections`) and **F2** (upload and inspection dashboard). The drawing viewer and evidence overlay are later milestones. See [F0](../docs/frontend-f0.md), [F1](../docs/frontend-f1.md) and [F2](../docs/frontend-f2.md).

```bash
npm ci
npm run dev           # http://127.0.0.1:3000 (bound to loopback only)
npm run check         # lint + typecheck + generated-types check + build + unit and component tests
npm run api:types     # regenerate src/api/schema.d.ts from ../backend/openapi.json
npm run test:server   # proxy tests against `next start` (after a build)
npm run test:backend  # proxy and screen tests against the real backend (after a build; needs `uv sync --locked` in ../backend)
```

Always start the app with `npm run dev` / `npm run start`. Running `next start` directly binds all network interfaces (Next's default), which would expose the backend through the proxy.

The proxy forwards to `BLUEPRINTIQ_BACKEND_URL` (server-side only; default `http://127.0.0.1:8000`, loopback IP literals only). Start the backend as described in the root README.

Requires Node.js 22.13+ or 24 (PDF.js 6 requirement). `/pdfjs-check` is a diagnostic page that proves the bundled PDF.js worker loads; it is not part of the product UI.

> Assistive prototype, not certified compliance software. Trusted local use only: the proxy is not production-secure.
