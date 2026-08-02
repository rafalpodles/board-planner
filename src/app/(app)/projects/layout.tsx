"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { Navbar } from "@/components/Navbar";
import { PmChatWidget } from "@/components/pm/PmChatWidget";

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      {/* No overflow-hidden here on purpose: tall project pages still scroll the window,
          while a page that opts into lg:flex-1 gets exactly the leftover height */}
      <div className="lg:h-dvh lg:flex lg:flex-col">
        <Navbar />
        <main className="max-w-[1920px] w-full mx-auto px-4 py-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
          {children}
        </main>
      </div>
      <PmChatWidget />
    </AuthGuard>
  );
}
