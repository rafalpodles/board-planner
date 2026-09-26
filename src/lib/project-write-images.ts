import { Project } from "@/models/project";

/**
 * The project around one atomic write, from that write's before-image alone: `after` is the image
 * with the update applied the way the schema stores it — unknown paths dropped, strings trimmed,
 * defaults filled — which is exactly what the document held the moment the write landed.
 */
export function projectWriteImages(beforeImage: object, updates: Record<string, unknown>) {
  const before = Project.hydrate(beforeImage).toObject();
  const after = Project.hydrate(beforeImage);
  after.set(updates);
  return { before, after };
}
