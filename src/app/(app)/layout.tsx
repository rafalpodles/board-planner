"use client";

import Image from "next/image";
import { useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { PmChatWidget } from "@/components/pm/PmChatWidget";
import { ProjectsProvider } from "@/components/shell/ProjectsProvider";
import { Sidebar } from "@/components/shell/Sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <AuthGuard>
      <ProjectsProvider>
        <div className="flex">
          <Sidebar mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} />

          {navOpen && (
            <div
              onClick={() => setNavOpen(false)}
              className="fixed inset-0 z-40 bg-black/50 md:hidden"
              aria-hidden
            />
          )}

          <div className="flex h-dvh min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 md:hidden">
              <button
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <Image src="/logo.svg" alt="" width={20} height={20} />
              <span className="text-sm font-bold">ClaudePlanner</span>
            </div>

            <main className="relative flex flex-1 flex-col overflow-y-auto px-4 py-6">
              {children}
            </main>
          </div>
        </div>
        <CommandPalette />
        <PmChatWidget />
      </ProjectsProvider>
    </AuthGuard>
  );
}
