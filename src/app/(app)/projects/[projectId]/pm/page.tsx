"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PmChat } from "@/components/pm/PmChat";

export default function PmChatPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div
      className="w-full max-w-3xl mx-auto flex flex-col"
      style={{ height: "calc(100vh - 3.5rem - 3.5rem)" }}
    >
      <div className="flex-1 min-h-0">
        <PmChat projectId={projectId} showTitle />
      </div>
    </div>
  );
}
