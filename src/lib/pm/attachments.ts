import mongoose from "mongoose";
import { projectForUpload, UPLOAD_BUCKET } from "@/lib/upload-ownership";
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

  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET });
  const found = await bucket.find({ _id: objectId }).toArray();
  if (found.length === 0) return null;

  // Before the bytes are read, not after. The route beside this one refuses first and streams
  // second; here the whole file was drained and only then compared, which let a caller from
  // another board spend the server's memory on files it could never see — and left a gap where
  // any log line or cache write added between the two would leak them (BP-290 review).
  //
  // `projectForUpload` rather than an open-coded read of the metadata, so one rule — and one set
  // of tests — serves both paths.
  if (projectForUpload(found[0]) !== String(projectId)) return null;

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of bucket.openDownloadStream(objectId)) {
      chunks.push(chunk as Buffer);
    }
  } catch {
    return null;
  }

  const mime = (found[0].metadata?.contentType as string) || a.mimeType;
  if (!IMAGE_MIME_TYPES.has(mime)) return null;

  // A file whose chunks are gone streams nothing and throws nothing, so without this the turn
  // carries `data:image/png;base64,` — an image of no bytes — instead of refusing.
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return null;

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * Whether any of these attachments is a readable image on this project — without draining bytes.
 *
 * Only the image-only case needs it. A turn with no text whose every attachment fails to load
 * would reach the provider with an empty user content, spending a turn against the cap on nothing
 * (BP-451 review): the shape checks in the route pass for a well-formed `fileId` that names no
 * file, or one belonging to another board.
 */
export async function anyAttachmentReadable(
  attachments: PmAttachment[],
  projectId: string
): Promise<boolean> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return false;

  // Keyed by the canonical id, not by what the client typed: ObjectId accepts hex in any case and
  // stringifies it lowercase, so a raw-string key misses for every non-canonical spelling.
  const claimed = new Map<string, string>();
  for (const a of attachments) {
    try {
      claimed.set(new mongoose.Types.ObjectId(a.fileId).toString(), a.mimeType);
    } catch {
      // a fileId that is not an id names no file
    }
  }
  const ids = [...claimed.keys()].map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return false;

  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: UPLOAD_BUCKET });
  const found = await bucket.find({ _id: { $in: ids } }).toArray();
  return found.some(
    (file) =>
      projectForUpload(file) === String(projectId) &&
      IMAGE_MIME_TYPES.has(
        (file.metadata?.contentType as string) || claimed.get(String(file._id)) || ""
      )
  );
}

// A message the model receives: plain string when there is nothing attached, so text-only
// turns keep exactly the shape they had before
export async function buildUserContent(
  text: string,
  attachments: PmAttachment[] | undefined,
  projectId: string
): Promise<string | Record<string, unknown>[]> {
  if (!attachments?.length) return text;

  // An image on its own carries no text, and an empty text block is something providers reject
  const blocks: Record<string, unknown>[] = text.trim() ? [{ type: "text", text }] : [];
  for (const a of attachments) {
    const url = await loadAttachmentDataUri(a, projectId);
    if (url) blocks.push({ type: "image_url", image_url: { url } });
  }
  return blocks.some((b) => b.type === "image_url") ? blocks : text;
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
