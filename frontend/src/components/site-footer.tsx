import Link from "next/link";

// Always rendered by the root layout. The AGPL-3.0 entitles everyone who uses a deployed copy
// over a network to its source code, so a deployment sets NEXT_PUBLIC_SOURCE_URL to the public
// repository of the version it runs; the link is shown whenever it is set.
export const SOURCE_URL_ENV = "NEXT_PUBLIC_SOURCE_URL";

/** The configured source address if it is a plain http(s) URL, otherwise null. */
export function sourceUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_SOURCE_URL,
): URL | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const FOOTER_LINK = "inline-flex min-h-8 items-center underline underline-offset-2 hover:text-foreground";

export function SiteFooter({ source = sourceUrl() }: { source?: URL | null }) {
  const notice =
    source === null
      ? null
      : new URL("blob/main/NOTICE.md", `${source.href.replace(/\/*$/, "")}/`);
  return (
    <footer className="mt-auto border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-4 text-sm text-muted sm:px-6">
        <nav aria-label="Footer" className="mb-2">
          <ul className="flex flex-wrap gap-x-5">
            <li>
              <Link className={FOOTER_LINK} href="/about">
                How it works and limits
              </Link>
            </li>
            <li>
              <Link className={FOOTER_LINK} href="/privacy">
                Privacy
              </Link>
            </li>
            <li>
              <Link className={FOOTER_LINK} href="/inspect">
                Inspect a drawing
              </Link>
            </li>
          </ul>
        </nav>
        <p>
          BlueprintIQ is free software under the{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://www.gnu.org/licenses/agpl-3.0.html"
          >
            GNU Affero General Public License v3
          </a>
          , with no warranty. It is an assistive prototype, not certified
          engineering-compliance software.
        </p>
        <p className="mt-1" data-testid="source-offer">
          {source !== null && notice !== null ? (
            <>
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={source.href}
              >
                Source code
              </a>{" "}
              of the version running here, and its{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={notice.href}
              >
                third-party notices
              </a>
              .
            </>
          ) : (
            <>
              The source code is in the project repository (see LICENSE and
              NOTICE.md).
            </>
          )}
        </p>
      </div>
    </footer>
  );
}
