import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";
import { APP_NAME } from "@/lib/brand";
import { linkPreviewMetadata } from "@/lib/link-preview";
import { NONCE_HEADER } from "@/lib/csp";
import { originOfHost } from "@/lib/organisation-host";

export async function generateMetadata(): Promise<Metadata> {
  const origin = originOfHost((await headers()).get("host"));
  return {
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    ...linkPreviewMetadata(APP_NAME),
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint, so the resolved theme is on <html> with no flash.
            Mirrors resolveTheme in ThemeProvider — change both together. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var p=localStorage.getItem('theme');if(p!=='light'&&p!=='dark')p='system';var t=p==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.setAttribute('data-theme',t);}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
