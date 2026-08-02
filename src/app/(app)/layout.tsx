"use client";

import Image from "next/image";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { PmChatWidget } from "@/components/pm/PmChatWidget";
import { ImportDialog } from "@/components/import-export/ImportDialog";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { ProjectsProvider } from "@/components/shell/ProjectsProvider";
import { Sidebar } from "@/components/shell/Sidebar";
import { emitBoardRefresh } from "@/lib/board-refresh";
import { projectRefFromPathname } from "@/lib/urls";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const projectRef = projectRefFromPathname(usePathname());

  return (
    <AuthGuard>
      <ProjectsProvider>
        <a
          href="#main-content"
          className="focus-ring sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-border focus:bg-bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-text"
        >
          Skip to content
        </a>
        <div className="flex">
          <Sidebar
            mobileOpen={navOpen}
            onNavigate={() => setNavOpen(false)}
            onOpenImport={() => setImportOpen(true)}
            onOpenExport={() => setExportOpen(true)}
          />

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

            {/* tabIndex makes the target focusable, or the skip link moves the
                viewport without moving focus and the next Tab starts from the top again */}
            <main
              id="main-content"
              tabIndex={-1}
              className="relative flex flex-1 flex-col overflow-y-auto px-4 py-6"
            >
              {children}
            </main>
          </div>
        </div>

        <CommandPalette />
        <PmChatWidget />

        {projectRef && (
          <>
            <ImportDialog
              open={importOpen}
              onClose={() => setImportOpen(false)}
              projectId={projectRef}
              onImported={() => emitBoardRefresh(projectRef)}
            />
            <ExportDialog
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              projectId={projectRef}
            />
          </>
        )}
      </ProjectsProvider>
    </AuthGuard>
  );
}
