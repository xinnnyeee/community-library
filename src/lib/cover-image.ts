/**
 * Resizes and re-encodes a photo to webp entirely in the browser, matching the
 * format the batch scanning pipeline already produces server-side with sharp.
 * Used by both the laptop add-book flow and the phone cover-upload page.
 */

const MAX_COVER_WIDTH = 400;
const COVER_QUALITY = 0.85;

export function resizeImageToWebp(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      const scale = Math.min(1, MAX_COVER_WIDTH / img.width);
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Canvas not supported in this browser"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) {
            reject(new Error("Failed to encode cover as webp"));
            return;
          }
          resolve(blob);
        },
        "image/webp",
        COVER_QUALITY,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load selected image"));
    };

    img.src = objectUrl;
  });
}
