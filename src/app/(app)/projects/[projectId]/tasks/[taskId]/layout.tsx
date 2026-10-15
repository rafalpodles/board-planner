import type { Metadata } from "next";
import { linkPreviewMetadata, taskLinkPreviewTitle } from "@/lib/link-preview";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}): Promise<Metadata> {
  const { projectId, taskId } = await params;
  const title = taskLinkPreviewTitle(projectId, taskId);
  return title ? linkPreviewMetadata(title) : {};
}

export default function TaskLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
