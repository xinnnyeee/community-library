/**
 * Resizes and re-encodes cover images to webp entirely in the browser,
 * matching the format the batch scanning pipeline already produces
 * server-side with sharp. Used by the laptop add-book flow, the phone
 * cover-upload page, and the PDF-page rendering in pdf-pages.ts - so a
 * cover looks the same regardless of which of those paths it came in
 * through.
 */

export const MAX_COVER_WIDTH = 400;
export const COVER_QUALITY = 0.85;

/** Draws a source (an <img> or a <canvas>) scaled down to MAX_COVER_WIDTH and encodes it as webp. */
function drawResizedToWebp(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const scale = Math.min(1, MAX_COVER_WIDTH / sourceWidth);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Canvas not supported in this browser"));
      return;
    }
    ctx.drawImage(source, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode cover as webp"));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      COVER_QUALITY,
    );
  });
}

export function resizeImageToWebp(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      drawResizedToWebp(img, img.width, img.height).then(resolve, reject).finally(() => {
        URL.revokeObjectURL(objectUrl);
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load selected image"));
    };

    img.src = objectUrl;
  });
}

/** Same resize + webp encode as resizeImageToWebp, but starting from an already-rendered canvas (e.g. a rendered PDF page) instead of a File. */
export function resizeCanvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return drawResizedToWebp(canvas, canvas.width, canvas.height);
}
