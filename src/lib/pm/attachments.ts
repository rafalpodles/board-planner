import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { PmAttachment } from "@/types";

// GridFS is behind withAuth and the app may not be reachable from OpenRouter, so images
// travel inline as data URIs rather than as links the provider would have to fetch
export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

// History replays every turn, so without a cap the same screenshots are re-billed
// on each one and the request grows without bound
export const MAX_REPLAYED_IMAGES = 4;

// Claude bills an image at roughly width*height/750 tokens
export function estimateImageTokens(a: PmAttachment): number {
  if (!a.width || !a.height) return 0;
  return Math.round((a.width * a.height) / 750);
}

// projectId is required, not optional: this is the second way to read a file out of GridFS, and
// leaving it ungated made the ownership check on GET /api/uploads/[fileId] bypassable outright.
export async function loadAttachmentDataUri(
  a: PmAttachment,
  projectId: string
): Promise<string | null> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return null;

  let objectId: mongoose.Types.ObjectId;
  try {
    objectId = new mongoose.Types.ObjectId(a.fileId);
  } catch {
    return null;
  }

  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });
  const found = await bucket.find({ _id: objectId }).toArray();
  if (found.length === 0) return null;

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of bucket.openDownloadStream(objectId)) {
      chunks.push(chunk as Buffer);
    }
  } catch {
    return null;
  }

  if (String(found[0].metadata?.project || "") !== String(projectId)) return null;

  const mime = (found[0].metadata?.contentType as string) || a.mimeType;
  if (!IMAGE_MIME_TYPES.has(mime)) return null;

  return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
}

// A message the model receives: plain string when there is nothing attached, so text-only
// turns keep exactly the shape they had before
export async function buildUserContent(
  text: string,
  attachments: PmAttachment[] | undefined,
  projectId: string
): Promise<string | Record<string, unknown>[]> {
  if (!attachments?.length) return text;

  const blocks: Record<string, unknown>[] = [{ type: "text", text }];
  for (const a of attachments) {
    const url = await loadAttachmentDataUri(a, projectId);
    if (url) blocks.push({ type: "image_url", image_url: { url } });
  }
  return blocks.length > 1 ? blocks : text;
}

interface ModelCapability {
  acceptsImages: boolean;
  checkedAt: number;
}

const CAPABILITY_TTL_MS = 60 * 60 * 1000;
const capabilityCache = new Map<string, ModelCapability>();

// Asked before an attachment is accepted, so a text-only model produces a clear message
// instead of a provider error the user cannot interpret
export async function modelAcceptsImages(model: string): Promise<boolean | null> {
  const cached = capabilityCache.get(model);
  if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) {
    return cached.acceptsImages;
  }

  const base = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = (data?.data as { id?: string; architecture?: { input_modalities?: string[] } }[] | undefined)?.find(
      (m) => m.id === model
    );
    if (!entry) return null;

    const acceptsImages = !!entry.architecture?.input_modalities?.includes("image");
    capabilityCache.set(model, { acceptsImages, checkedAt: Date.now() });
    return acceptsImages;
  } catch {
    // Unknown rather than false: a network blip must not look like "this model is text-only"
    return null;
  }
}
