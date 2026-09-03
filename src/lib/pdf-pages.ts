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
