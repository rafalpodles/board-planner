import type { Metadata } from "next";
import { APP_DESCRIPTION, APP_NAME } from "./brand";
import { PROJECT_KEY_PATTERN } from "./urls";

export const LINK_PREVIEW_IMAGE_SIZE = { width: 1200, height: 630 };

const TASK_NUMBER_PATTERN = /^[1-9]\d{0,9}$/;

export function taskLinkPreviewTitle(projectRef: string, taskRef: string): string | null {
  if (!PROJECT_KEY_PATTERN.test(projectRef) || !TASK_NUMBER_PATTERN.test(taskRef)) return null;
  return `${projectRef.toUpperCase()}-${taskRef} — ${APP_NAME}`;
}

// Next merges openGraph and twitter whole, not field by field, so a segment naming its title restates the rest
export function linkPreviewMetadata(title: string): Metadata {
  const images = [{ url: "/opengraph-image", ...LINK_PREVIEW_IMAGE_SIZE, alt: APP_NAME }];
  return {
    title,
    description: APP_DESCRIPTION,
    openGraph: { siteName: APP_NAME, title, description: APP_DESCRIPTION, type: "website", images },
    twitter: { card: "summary_large_image", title, description: APP_DESCRIPTION, images },
  };
}
