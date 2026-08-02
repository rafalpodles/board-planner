// A retina screenshot is several megabytes and costs roughly width*height/750 tokens on
// every turn it stays in history, so it is shrunk in the browser before it is ever stored
export const MAX_IMAGE_DIMENSION = 1568;

export interface ResizedImage {
  file: File;
  width: number;
  height: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read that image"));
    img.src = src;
  });
}

export async function downscaleImage(file: File): Promise<ResizedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process that image");
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85)
    );
    if (!blob) throw new Error("Could not process that image");

    const name = file.name.replace(/\.[^.]+$/, "") || "screenshot";
    return {
      file: new File([blob], `${name}.webp`, { type: "image/webp" }),
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function estimateImageTokens(width: number, height: number): number {
  return Math.round((width * height) / 750);
}
