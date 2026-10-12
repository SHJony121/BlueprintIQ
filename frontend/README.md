# BlueprintIQ frontend (Phase 2A)

Local Next.js + TypeScript + Tailwind interface for the BlueprintIQ backend. Done so far: **F0** (scaffold, PDF.js worker check) and **F1** (server-side proxy `POST /api/inspections` to the backend). The upload screen, viewer and evidence overlay are later milestones. See [docs/frontend-f0.md](../docs/frontend-f0.md) and [docs/frontend-f1.md](../docs/frontend-f1.md).

```bash
npm ci
npm run dev           # http://127.0.0.1:3000 (bound to loopback only)
npm run check         # lint + typecheck + production build + unit tests
npm run test:server   # proxy tests against `next start` (after a build)
npm run test:backend  # proxy tests against the real backend (after a build; needs `uv sync --locked` in ../backend)
```

Always start the app with `npm run dev` / `npm run start`. Running `next start` directly binds all network interfaces (Next's default), which would expose the backend through the proxy.

The proxy forwards to `BLUEPRINTIQ_BACKEND_URL` (server-side only; default `http://127.0.0.1:8000`, loopback IP literals only). Start the backend as described in the root README.

Requires Node.js 22.13+ or 24 (PDF.js 6 requirement). `/pdfjs-check` is a diagnostic page that proves the bundled PDF.js worker loads; it is not part of the product UI.

> Assistive prototype, not certified compliance software. Trusted local use only: the proxy is not production-secure.
