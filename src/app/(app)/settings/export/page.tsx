"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";

export default function ExportSettingsPage() {
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !isAdmin) router.replace("/projects");
  }, [isAdmin, authLoading, router]);

  if (authLoading || !isAdmin) return null;

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Export</h2>
      <p className="text-sm text-text-muted mb-6">
        Everything this organisation holds, in one file: boards, tasks, comments, people, settings and
        uploaded files. Passwords, sign-in tokens and links still in flight are left out.
      </p>
      <a
        href="/api/admin/export"
        download
        className="inline-flex items-center justify-center rounded-lg font-medium transition-colors
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
          bg-primary-solid hover:bg-primary-solid-hover text-white px-4 py-2 text-sm min-h-[44px]"
      >
        Download the export
      </a>
      <p className="mt-2 text-sm text-text-muted">
        A gzip-compressed file of JSON lines, one per record. The download is written to the audit log.
      </p>
    </div>
  );
}
