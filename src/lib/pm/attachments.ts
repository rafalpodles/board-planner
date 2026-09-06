import mongoose from "mongoose";
import { projectForUpload, UPLOAD_BUCKET } from "@/lib/upload-ownership";
import { connectDB } from "@/lib/db";
import { PmAttachment } from "@/types";

export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export const MAX_REPLAYED_IMAGES = 4;

export function estimateImageTokens(a: PmAttachment): number {
  if (!a.width || !a.height) return 0;
  return Math.round((a.width * a.height) / 750);
}

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

  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return null;

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function anyAttachmentReadable(
  attachments: PmAttachment[],
  projectId: string
): Promise<boolean> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return false;

  const claimed = new Map<string, string>();
  for (const a of attachments) {
    try {
      claimed.set(new mongoose.Types.ObjectId(a.fileId).toString(), a.mimeType);
    } catch {
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

export async function buildUserContent(
  text: string,
  attachments: PmAttachment[] | undefined,
  projectId: string
): Promise<string | Record<string, unknown>[]> {
  if (!attachments?.length) return text;

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
    return null;
  }
}
