"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PmChat } from "@/components/pm/PmChat";

export default function PmChatPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: "calc(100vh - 3.5rem - 3.5rem)" }}>
      <div className="px-3 pt-1">
        <Link href={`/projects/${projectId}`} className="text-sm text-text-muted hover:text-text">
          ← Back to board
        </Link>
      </div>
      <div className="flex-1 min-h-0">
        <PmChat projectId={projectId} showTitle />
      </div>
    </div>
  );
}
