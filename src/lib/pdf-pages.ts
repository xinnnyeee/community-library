/**
 * Renders every page of a PDF file to an in-memory canvas, entirely in the
 * browser (via pdf.js) - used by the batch cover-upload flow on
 * /admin/add-covers, where one multi-page PDF of scanned covers gets split
 * back out into individual covers.
 */

import * as pdfjsLib from "pdfjs-dist";
// Vite-specific import: resolves to the URL of the worker file so it can be
// loaded as a separate script, rather than bundled inline.
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// A bit of headroom over MAX_COVER_WIDTH (400px, see cover-image.ts) so the
// final downsized+webp-encoded cover still looks crisp.
const RENDER_WIDTH = 600;

export type PdfPage = {
  pageNumber: number;
  /** Data URL for a thumbnail preview - cheap to keep around, no cleanup needed. */
  previewUrl: string;
  /** The full-resolution render, re-used at upload time via resizeCanvasToWebp. */
  canvas: HTMLCanvasElement;
};

export async function renderPdfPages(file: File): Promise<PdfPage[]> {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: RENDER_WIDTH / unscaledViewport.width,
    });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas not supported in this browser");
    }

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    pages.push({
      pageNumber: i,
      previewUrl: canvas.toDataURL("image/png"),
      canvas,
    });
  }
  return pages;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Builds a minimal PDF with one full-page JPEG image per page, with no
 * external library - the standard "DCTDecode" embedding trick, which just
 * wraps the browser's own JPEG bytes (from canvas.toDataURL) in PDF object
 * syntax, no re-encoding needed. Used to export the leftover "unused"
 * pages from a batch cover upload back out as a PDF, e.g. to carry over
 * into the next scanning batch.
 */
export function buildPdfFromCanvases(canvases: HTMLCanvasElement[]): Blob {
  const pages = canvases.map((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    jpegBytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.9)),
  }));

  const pageObjNum = (i: number) => 3 + i * 3;
  const imageObjNum = (i: number) => pageObjNum(i) + 1;
  const contentObjNum = (i: number) => pageObjNum(i) + 2;

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: Record<number, number> = {};
  let offset = 0;

  function write(bytes: Uint8Array) {
    parts.push(bytes);
    offset += bytes.length;
  }
  function writeText(text: string) {
    write(encoder.encode(text));
  }
  function beginObj(num: number) {
    offsets[num] = offset;
    writeText(`${num} 0 obj\n`);
  }

  writeText("%PDF-1.4\n");

  beginObj(1);
  writeText("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObj(2);
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");
  writeText(
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`,
  );

  pages.forEach(({ width, height, jpegBytes }, i) => {
    beginObj(pageObjNum(i));
    writeText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageObjNum(i)} 0 R >> >> ` +
        `/Contents ${contentObjNum(i)} 0 R >>\nendobj\n`,
    );

    beginObj(imageObjNum(i));
    writeText(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpegBytes.length} >>\nstream\n`,
    );
    write(jpegBytes);
    writeText("\nendstream\nendobj\n");

    const contentBytes = encoder.encode(
      `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`,
    );
    beginObj(contentObjNum(i));
    writeText(`<< /Length ${contentBytes.length} >>\nstream\n`);
    write(contentBytes);
    writeText("\nendstream\nendobj\n");
  });

  const xrefOffset = offset;
  const totalObjs = 2 + pages.length * 3;
  writeText(`xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= totalObjs; n++) {
    writeText(`${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  writeText(
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );

  return new Blob(parts, { type: "application/pdf" });
}

/** Triggers a browser download of `blob` named `filename`. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
