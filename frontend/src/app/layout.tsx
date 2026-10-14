import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

// The social-preview image needs an absolute address. A deployment sets NEXT_PUBLIC_SITE_URL to
// its public origin; without it the metadata stays relative and nothing is invented.
function siteOrigin(): URL | undefined {
  try {
    const raw = process.env.NEXT_PUBLIC_SITE_URL;
    return raw === undefined || raw === "" ? undefined : new URL(raw);
  } catch {
    return undefined;
  }
}

const DESCRIPTION =
  "Check an engineering drawing PDF against your limits, with the evidence beside every result. An assistive prototype, not certified compliance software.";

const ORIGIN = siteOrigin();
const PREVIEW = [{ url: "/og", width: 1200, height: 630, alt: "BlueprintIQ: engineering drawing inspection" }];

export const metadata: Metadata = {
  metadataBase: ORIGIN,
  title: { default: "BlueprintIQ: engineering drawing inspection", template: "%s | BlueprintIQ" },
  description: DESCRIPTION,
  applicationName: "BlueprintIQ",
  openGraph: {
    type: "website",
    siteName: "BlueprintIQ",
    title: "BlueprintIQ: engineering drawing inspection",
    description: DESCRIPTION,
    ...(ORIGIN === undefined ? {} : { images: PREVIEW }),
  },
  twitter: {
    card: ORIGIN === undefined ? "summary" : "summary_large_image",
    title: "BlueprintIQ: engineering drawing inspection",
    description: DESCRIPTION,
    ...(ORIGIN === undefined ? {} : { images: ["/og"] }),
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
