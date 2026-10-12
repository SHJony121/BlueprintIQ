# BlueprintIQ frontend (Phase 2A)

Local Next.js + TypeScript + Tailwind interface for the BlueprintIQ backend. **F0 (scaffold) only:** the upload and inspection screen, the backend proxy and the evidence overlay are later milestones. See [docs/frontend-f0.md](../docs/frontend-f0.md).

```bash
npm ci
npm run dev        # http://localhost:3000
npm run check      # lint + typecheck + production build
```

Requires Node.js 22.13+ or 24 (PDF.js 6 requirement). `/pdfjs-check` is a diagnostic page that proves the bundled PDF.js worker loads; it is not part of the product UI.

> Assistive prototype, not certified compliance software.
