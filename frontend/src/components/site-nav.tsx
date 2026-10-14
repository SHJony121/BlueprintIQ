"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/inspect", label: "Inspect" },
  { href: "/about", label: "How it works" },
  { href: "/privacy", label: "Privacy" },
] as const;

export function SiteNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="-mx-2">
      <ul className="flex flex-wrap items-center gap-x-1 text-sm">
        {LINKS.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-10 items-center rounded-md px-2 hover:text-accent ${
                  current ? "font-semibold text-accent" : "text-foreground"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
