import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/page-shell";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <PageShell title="Page not found" intro="There is nothing at this address.">
      <p className="text-sm">
        <Link className="text-accent underline underline-offset-4" href="/">
          Back to the start
        </Link>{" "}
        or{" "}
        <Link className="text-accent underline underline-offset-4" href="/inspect">
          inspect a drawing
        </Link>
        .
      </p>
    </PageShell>
  );
}
