import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { client } from "@/lib/api-client";
import { resizeCanvasToWebp, resizeImageToWebp } from "@/lib/cover-image";
import { renderPdfPages, type PdfPage } from "@/lib/pdf-pages";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

/**
 * Admin "add covers" page: shows every book that's missing a cover and lets
 * you attach one - either one at a time (photo/file per book), or in bulk
 * from a single multi-page PDF (e.g. a batch of scans from CamScanner),
 * matched to the selected books in order with a chance to rearrange before
 * confirming.
 *
 * Every upload here goes through the same POST /admin/books/:isbn/cover
 * endpoint that /admin/add-book/cover/:isbn uses - this page is just a
 * different (and bulk-capable) front end for it. "Remove" clears a book's
 * image_url back to null via DELETE on that same path; it never removes
 * the file from the GitHub images repo, just the reference.
 */

type CoverlessBook = {
  id: number;
  isbn: string;
  title: string;
  author: string;
  imageUrl: string | null;
};

const booksApi = client.api.admin.books;

// Keeps each page's grid to a size that roughly matches one batch-scanned
// stack of covers, and keeps "select all on this page" a meaningful action
// rather than selecting hundreds of books at once.
const PAGE_SIZE = 15;

export default function AddCovers() {
  const [books, setBooks] = useState<CoverlessBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [page, setPage] = useState(0);
  // Freshly-uploaded cover previews, keyed by isbn - lets a card show its
  // new image immediately without waiting on a refetch (the server list
  // won't include it any more, since it's no longer coverless).
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>(
    {},
  );

  async function loadBooks() {
    setLoading(true);
    try {
      const res = await booksApi.coverless.$get();
      const data = await res.json();
      setBooks(data.books);
      setSelected(new Set());
      setPage(0);
    } catch {
      toast.error("Couldn't reach the server. Is `bun run dev` running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBooks();
  }, []);

  function toggleSelected(isbn: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(isbn)) next.delete(isbn);
      else next.add(isbn);
      return next;
    });
  }

  function markUploaded(isbn: string, previewUrl: string, title: string) {
    setLocalPreviews((prev) => ({ ...prev, [isbn]: previewUrl }));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(isbn);
      return next;
    });
    toast.success(`Cover added: ${title}`);
  }

  async function uploadCover(isbn: string, file: File) {
    try {
      const webpBlob = await resizeImageToWebp(file);
      const coverFile = new File([webpBlob], `${isbn}.webp`, {
        type: "image/webp",
      });
      const res = await booksApi[":isbn"].cover.$post({
        param: { isbn },
        form: { cover: coverFile },
      });
      const data = await res.json();
      if (!res.ok || "error" in data) {
        toast.error("error" in data ? data.error : "Upload failed");
        return;
      }
      markUploaded(isbn, URL.createObjectURL(coverFile), data.book.title);
    } catch {
      toast.error("Upload failed - check you're connected");
    }
  }

  async function removeCover(isbn: string) {
    try {
      const res = await booksApi[":isbn"].cover.$delete({ param: { isbn } });
      const data = await res.json();
      if (!res.ok || "error" in data) {
        toast.error("error" in data ? data.error : "Failed to remove cover");
        return;
      }
      setLocalPreviews((prev) => {
        const next = { ...prev };
        delete next[isbn];
        return next;
      });
      toast.success("Cover removed");
    } catch {
      toast.error("Failed to remove cover - check you're connected");
    }
  }

  const selectedBooks = books.filter((b) => selected.has(b.isbn));

  const totalPages = Math.max(1, Math.ceil(books.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pagedBooks = books.slice(
    currentPage * PAGE_SIZE,
    currentPage * PAGE_SIZE + PAGE_SIZE,
  );
  // "Select all" only ever acts on books shown on the current page, and
  // only the ones actually selectable (a card with a freshly-uploaded local
  // preview has its checkbox disabled, same as CoverCard below).
  const pageSelectableIsbns = pagedBooks
    .filter((b) => !localPreviews[b.isbn])
    .map((b) => b.isbn);
  const allPageSelected =
    pageSelectableIsbns.length > 0 &&
    pageSelectableIsbns.every((isbn) => selected.has(isbn));

  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const isbn of pageSelectableIsbns) next.delete(isbn);
      } else {
        for (const isbn of pageSelectableIsbns) next.add(isbn);
      }
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Toaster />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Add Covers</h1>
          <p className="text-muted-foreground text-sm">
            {books.length} book{books.length === 1 ? "" : "s"} missing a
            cover
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={loadBooks}>
            Refresh
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/manage-books">Manage books</Link>
          </Button>
          <Button
            disabled={selected.size < 2}
            onClick={() => setBatchOpen(true)}
          >
            Batch upload ({selected.size})
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : books.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Every book has a cover - nothing to do here.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex cursor-pointer items-center gap-2 text-sm select-none"
              onClick={toggleSelectAllOnPage}
            >
              <Checkbox
                checked={allPageSelected}
                disabled={pageSelectableIsbns.length === 0}
                onCheckedChange={toggleSelectAllOnPage}
                onClick={(e) => e.stopPropagation()}
              />
              Select all on this page ({pageSelectableIsbns.length})
            </div>

            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage === 0}
                >
                  Previous
                </Button>
                <span className="text-muted-foreground">
                  Page {currentPage + 1} of {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {pagedBooks.map((book) => (
              <CoverCard
                key={book.isbn}
                book={book}
                previewUrl={localPreviews[book.isbn]}
                selected={selected.has(book.isbn)}
                onToggleSelected={() => toggleSelected(book.isbn)}
                onUpload={(file) => uploadCover(book.isbn, file)}
                onRemove={() => removeCover(book.isbn)}
              />
            ))}
          </div>
        </>
      )}

      {batchOpen && (
        <BatchUploadDialog
          books={selectedBooks}
          onClose={() => setBatchOpen(false)}
          onUploaded={(results) => {
            setLocalPreviews((prev) => {
              const next = { ...prev };
              for (const { isbn, blob } of results) {
                next[isbn] = URL.createObjectURL(blob);
              }
              return next;
            });
            setSelected((prev) => {
              const next = new Set(prev);
              for (const { isbn } of results) next.delete(isbn);
              return next;
            });
            setBatchOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CoverCard({
  book,
  previewUrl,
  selected,
  onToggleSelected,
  onUpload,
  onRemove,
}: {
  book: CoverlessBook;
  previewUrl?: string;
  selected: boolean;
  onToggleSelected: () => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasCover = !!previewUrl;

  return (
    <div className="relative rounded-md border p-2">
      <div className="absolute top-3 left-3 z-10">
        <Checkbox
          checked={selected}
          disabled={hasCover}
          onCheckedChange={onToggleSelected}
          className="bg-background"
        />
      </div>

      <div className="bg-muted mb-2 flex aspect-2/3 items-center justify-center overflow-hidden rounded">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={book.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-muted-foreground px-2 text-center text-xs">
            No cover yet
          </span>
        )}
      </div>

      <p className="truncate text-sm font-medium" title={book.title}>
        {book.title}
      </p>
      <p className="text-muted-foreground truncate text-xs" title={book.author}>
        {book.author}
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />

      <div className="mt-2 flex gap-1">
        {hasCover ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => fileInputRef.current?.click()}
            >
              Replace
            </Button>
            <Button size="sm" variant="destructive" onClick={onRemove}>
              Remove
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="w-full"
            onClick={() => fileInputRef.current?.click()}
          >
            Add
          </Button>
        )}
      </div>
    </div>
  );
}

type Assignments = Record<string, number | null>;

function BatchUploadDialog({
  books,
  onClose,
  onUploaded,
}: {
  books: CoverlessBook[];
  onClose: () => void;
  onUploaded: (results: { isbn: string; blob: Blob }[]) => void;
}) {
  const [pages, setPages] = useState<PdfPage[]>([]);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [rendering, setRendering] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [draggingPage, setDraggingPage] = useState<number | null>(null);

  async function handleFileSelected(file: File) {
    setRendering(true);
    try {
      const rendered = await renderPdfPages(file);
      setPages(rendered);

      // Auto-align: the Nth selected book gets the Nth page, in order.
      const initial: Assignments = {};
      books.forEach((book, i) => {
        initial[book.isbn] = rendered[i]?.pageNumber ?? null;
      });
      setAssignments(initial);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that PDF");
    } finally {
      setRendering(false);
    }
  }

  const assignedPageNumbers = new Set(
    Object.values(assignments).filter((p): p is number => p !== null),
  );
  const unusedPages = pages.filter(
    (p) => !assignedPageNumbers.has(p.pageNumber),
  );
  const assignedCount = Object.values(assignments).filter(
    (p) => p !== null,
  ).length;

  function findAssignedIsbn(pageNumber: number): string | undefined {
    return Object.entries(assignments).find(
      ([, p]) => p === pageNumber,
    )?.[0];
  }

  function handleDropOnBook(targetIsbn: string) {
    if (draggingPage === null) return;
    const sourceIsbn = findAssignedIsbn(draggingPage);

    setAssignments((prev) => {
      const next = { ...prev };
      const displaced = next[targetIsbn] ?? null;
      next[targetIsbn] = draggingPage;
      // Swap rather than duplicate: whatever page was at the target moves
      // to wherever the dragged page came from (a no-op if it came from
      // the unused tray).
      if (sourceIsbn && sourceIsbn !== targetIsbn) {
        next[sourceIsbn] = displaced;
      }
      return next;
    });
    setDraggingPage(null);
  }

  function handleDropOnTray() {
    if (draggingPage === null) return;
    const sourceIsbn = findAssignedIsbn(draggingPage);
    if (sourceIsbn) {
      setAssignments((prev) => ({ ...prev, [sourceIsbn]: null }));
    }
    setDraggingPage(null);
  }

  async function handleConfirm() {
    setUploading(true);
    setProgress(0);

    const toUpload = books
      .map((book) => ({ book, pageNumber: assignments[book.isbn] }))
      .filter(
        (x): x is { book: CoverlessBook; pageNumber: number } =>
          x.pageNumber !== null,
      );

    const results: { isbn: string; blob: Blob }[] = [];
    const failed: { isbn: string; reason: string }[] = [];

    for (const [i, { book, pageNumber }] of toUpload.entries()) {
      const page = pages.find((p) => p.pageNumber === pageNumber);
      if (!page) continue;
      try {
        const blob = await resizeCanvasToWebp(page.canvas);
        const coverFile = new File([blob], `${book.isbn}.webp`, {
          type: "image/webp",
        });
        const res = await booksApi[":isbn"].cover.$post({
          param: { isbn: book.isbn },
          form: { cover: coverFile },
        });
        const data = await res.json();
        if (!res.ok || "error" in data) {
          failed.push({
            isbn: book.isbn,
            reason: "error" in data ? data.error : "Upload failed",
          });
        } else {
          results.push({ isbn: book.isbn, blob });
        }
      } catch (err) {
        failed.push({
          isbn: book.isbn,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      setProgress(Math.round(((i + 1) / toUpload.length) * 100));
    }

    setUploading(false);

    if (results.length > 0) {
      toast.success(
        `Uploaded ${results.length} cover${results.length === 1 ? "" : "s"}`,
      );
    }
    if (failed.length > 0) {
      toast.error(
        `${failed.length} failed: ${failed
          .map((f) => `${f.isbn} (${f.reason})`)
          .join("; ")}`,
      );
    }
    onUploaded(results);
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !uploading && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Batch upload covers</DialogTitle>
          <DialogDescription>
            Upload one PDF with a scanned cover on each page. Pages are
            matched to the {books.length} selected book
            {books.length === 1 ? "" : "s"} in order by default - drag a page
            onto a different book to rearrange before confirming.
          </DialogDescription>
        </DialogHeader>

        {pages.length === 0 ? (
          <div className="space-y-3">
            <input
              type="file"
              accept="application/pdf"
              disabled={rendering}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelected(file);
              }}
            />
            {rendering && (
              <p className="text-muted-foreground text-sm">
                Rendering pages...
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {pages.length !== books.length && (
              <p className="text-sm text-amber-600">
                {pages.length} page{pages.length === 1 ? "" : "s"} in the
                PDF, {books.length} book{books.length === 1 ? "" : "s"}{" "}
                selected -{" "}
                {pages.length > books.length
                  ? `${pages.length - books.length} extra page(s) are left unused below.`
                  : `${books.length - pages.length} book(s) below won't get a page unless you drag one in.`}
              </p>
            )}

            <div className="space-y-2">
              {books.map((book) => {
                const pageNumber = assignments[book.isbn];
                const page =
                  pageNumber != null
                    ? pages.find((p) => p.pageNumber === pageNumber)
                    : undefined;
                return (
                  <div
                    key={book.isbn}
                    className="flex items-center gap-3 rounded-md border p-2"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDropOnBook(book.isbn)}
                  >
                    <div className="bg-muted flex h-20 w-14 shrink-0 items-center justify-center overflow-hidden rounded">
                      {page ? (
                        <img
                          src={page.previewUrl}
                          draggable
                          onDragStart={() => setDraggingPage(page.pageNumber)}
                          alt={`Page ${page.pageNumber}`}
                          className="h-full w-full cursor-grab object-cover"
                        />
                      ) : (
                        <span className="text-muted-foreground px-1 text-center text-[10px]">
                          drop page here
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {book.title}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {book.isbn}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {unusedPages.length > 0 && (
              <div
                className="rounded-md border border-dashed p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDropOnTray}
              >
                <p className="text-muted-foreground mb-2 text-xs">
                  Unused pages - drag one onto a book above to use it
                </p>
                <div className="flex flex-wrap gap-2">
                  {unusedPages.map((page) => (
                    <img
                      key={page.pageNumber}
                      src={page.previewUrl}
                      draggable
                      onDragStart={() => setDraggingPage(page.pageNumber)}
                      alt={`Page ${page.pageNumber}`}
                      className="h-20 w-14 cursor-grab rounded object-cover"
                    />
                  ))}
                </div>
              </div>
            )}

            {uploading && <Progress value={progress} />}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          {pages.length > 0 && (
            <Button
              onClick={handleConfirm}
              disabled={uploading || assignedCount === 0}
            >
              {uploading
                ? "Uploading..."
                : `Upload ${assignedCount} cover${assignedCount === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
