import { notFound } from "next/navigation";

// A diagnostic page for development and the browser tests, not part of the product. It exists
// only where BLUEPRINTIQ_ENABLE_DIAGNOSTICS=1 is set; a public deployment never sets it. The
// layout is rendered per request so the setting is read at run time, not frozen at build time.
export const dynamic = "force-dynamic";

export default function DiagnosticLayout({ children }: { children: React.ReactNode }) {
  if (process.env.BLUEPRINTIQ_ENABLE_DIAGNOSTICS !== "1") notFound();
  return children;
}
