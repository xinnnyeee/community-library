import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BOOK_CATEGORIES, type BookCategory } from "../../shared/categories";
import { client } from "@/lib/api-client";
import { resizeImageToWebp } from "@/lib/cover-image";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

/**
 * Admin tool: scan ISBN -> Google Books lookup -> scan/photo the cover -> save.
 *
 * Workflow:
 *  1. Focus stays on the ISBN field. A USB barcode scanner "types" the ISBN and
 *     hits Enter, which triggers step 2 automatically.
 *  2. We look up the ISBN against Google Books (and check for an existing book
 *     with the same ISBN so we never create a duplicate).
 *  3. The fetched title/author/description are shown, editable. Saving inserts
 *     ONE new row into `books` (never touches existing rows, copies, loans, or
 *     locations).
 *  4. The cover photo can be attached from THIS device (camera on mobile, file
 *     picker on desktop), or - since this page usually runs on a laptop without
 *     a good camera - handed off to a phone: after saving, a QR code opens a
 *     small mobile page that snaps the photo and uploads it straight to that
 *     one book. Either way, the photo is resized + re-encoded to webp in the
 *     browser before upload (matching the format the batch pipeline produces).
 */

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "duplicate"; isbn: string; existingTitle: string }
  | {
      status: "found";
      isbn: string;
      title: string;
      author: string;
      description: string;
    }
  | { status: "not-found"; isbn: string }
  | { status: "lookup-failed"; isbn: string; reason: string };

type SavedState = { isbn: string; title: string; hasCover: boolean } | null;

export default function AddBook() {
  const isbnInputRef = useRef<HTMLInputElement>(null);
  const [isbnInput, setIsbnInput] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ status: "idle" });

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<BookCategory | "">("");

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  const [saved, setSaved] = useState<SavedState>(null);

  useEffect(() => {
    isbnInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  function resetForm() {
    setIsbnInput("");
    setLookup({ status: "idle" });
    setTitle("");
    setAuthor("");
    setDescription("");
    setCategory("");
    setCoverFile(null);
    setSaved(null);
    refocusIsbnInput();
  }

  /**
   * A USB barcode scanner just sends raw keystrokes to whatever currently has
   * focus. After "Look up" is clicked, the browser moves focus to that button
   * - so scanning the next book's barcode would type into nothing, and its
   * trailing Enter would just re-click "Look up" and resubmit the OLD ISBN
   * still sitting in the field. Call this after every lookup result so focus
   * (and a full text selection, so the next scan overwrites rather than
   * appends) is always back on the ISBN field, ready for the next scan.
   */
  function refocusIsbnInput() {
    isbnInputRef.current?.focus();
    isbnInputRef.current?.select();
  }

  async function handleIsbnSubmit(e: React.FormEvent) {
    e.preventDefault();
    const raw = isbnInput.trim();
    if (!raw) return;

    setLookup({ status: "loading" });
    try {
      const res = await client.api.admin.books.lookup[":isbn"].$get({
        param: { isbn: raw },
      });
      const data = await res.json();

      if ("error" in data) {
        toast.error(data.error);
        setLookup({ status: "idle" });
        refocusIsbnInput();
        return;
      }

      if (data.duplicate && data.existing) {
        setLookup({
          status: "duplicate",
          isbn: data.isbn,
          existingTitle: data.existing.title,
        });
        refocusIsbnInput();
        return;
      }

      setTitle("");
      setAuthor("");
      setDescription("");
      setCategory("");

      if (data.google) {
        setTitle(data.google.title);
        setAuthor(data.google.author);
        setDescription(data.google.description);
        setLookup({
          status: "found",
          isbn: data.isbn,
          title: data.google.title,
          author: data.google.author,
          description: data.google.description,
        });
      } else if (data.googleError) {
        // The lookup itself failed (network/rate-limit/etc) - this is NOT the
        // same as "Google Books genuinely has no record", so say so, and let
        // manual entry proceed anyway.
        setLookup({
          status: "lookup-failed",
          isbn: data.isbn,
          reason: data.googleError,
        });
      } else {
        // Lookup succeeded but Google Books truly has no record for this ISBN.
        setLookup({ status: "not-found", isbn: data.isbn });
      }
      refocusIsbnInput();
    } catch {
      toast.error("Couldn't reach the server. Is `bun run dev` running?");
      setLookup({ status: "idle" });
      refocusIsbnInput();
    }
  }

  function handleCoverSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCoverFile(file);
  }

  async function handleSave() {
    if (
      lookup.status !== "found" &&
      lookup.status !== "not-found" &&
      lookup.status !== "lookup-failed"
    )
      return;
    const isbn = lookup.isbn;

    if (!title.trim() || !author.trim()) {
      toast.error("Title and author are required");
      return;
    }

    setSaving(true);
    try {
      const coverPart = coverFile
        ? { cover: new File([await resizeImageToWebp(coverFile)], `${isbn}.webp`, { type: "image/webp" }) }
        : {};

      const res = await client.api.admin.books.$post({
        form: {
          isbn,
          title: title.trim(),
          author: author.trim(),
          description: description.trim() || "No description available",
          ...(category ? { category } : {}),
          ...coverPart,
        },
      });
      const data = await res.json();

      if ("error" in data) {
        toast.error(data.error);
        return;
      }

      setAddedCount((n) => n + 1);
      toast.success(`Added: ${title}`);
      setSaved({ isbn, title, hasCover: !!coverFile });
    } catch {
      toast.error("Couldn't reach the server. Is `bun run dev` running?");
    } finally {
      setSaving(false);
    }
  }

  const showDetailsForm =
    !saved &&
    (lookup.status === "found" ||
      lookup.status === "not-found" ||
      lookup.status === "lookup-failed");

  const isLocalhost =
    typeof window !== "undefined" && window.location.hostname === "localhost";
  const coverUploadUrl =
    saved && typeof window !== "undefined"
      ? `${window.location.origin}/admin/add-book/cover/${saved.isbn}`
      : "";

  return (
    <div className="mx-auto max-w-xl p-6">
      <Toaster />
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Add New Book</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">
            {addedCount} added this session
          </span>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/manage-books">Manage books</Link>
          </Button>
        </div>
      </div>

      {!saved && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>1. Scan ISBN</CardTitle>
            <CardDescription>
              Focus stays here between scans - a USB barcode scanner will type
              the ISBN and press Enter for you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleIsbnSubmit} className="flex gap-2">
              <Input
                ref={isbnInputRef}
                value={isbnInput}
                onChange={(e) => setIsbnInput(e.target.value)}
                placeholder="Scan or type ISBN"
                disabled={lookup.status === "loading"}
                autoComplete="off"
              />
              <Button type="submit" disabled={lookup.status === "loading"}>
                {lookup.status === "loading" ? "Looking up..." : "Look up"}
              </Button>
            </form>

            {lookup.status === "duplicate" && (
              <p className="text-destructive mt-3 text-sm">
                Already in the catalog: <strong>{lookup.existingTitle}</strong>{" "}
                ({lookup.isbn}). Nothing was changed.{" "}
                <button type="button" className="underline" onClick={resetForm}>
                  Scan a different book
                </button>
              </p>
            )}

            {lookup.status === "not-found" && (
              <p className="mt-3 text-sm text-amber-600">
                No Google Books match for {lookup.isbn} - fill in the details
                manually below.
              </p>
            )}

            {lookup.status === "lookup-failed" && (
              <p className="text-destructive mt-3 text-sm">
                Google Books lookup failed for {lookup.isbn}: {lookup.reason}.
                This isn't the same as "book doesn't exist" - you can retry by
                looking it up again, or fill in the details manually below.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {showDetailsForm && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>2. Review details</CardTitle>
            <CardDescription>ISBN {"isbn" in lookup ? lookup.isbn : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="author">Author</Label>
              <Input id="author" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as BookCategory)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a category (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {BOOK_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      {showDetailsForm && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>3. Cover photo (optional now)</CardTitle>
            <CardDescription>
              Attach a cover now from this device, or skip it and use the QR
              handoff to your phone after saving.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleCoverSelected}
            />
            {coverPreviewUrl && (
              <img
                src={coverPreviewUrl}
                alt="Cover preview"
                className="mt-3 h-40 rounded border object-contain"
              />
            )}
          </CardContent>
        </Card>
      )}

      {showDetailsForm && (
        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? "Saving..." : "4. Save book"}
        </Button>
      )}

      {saved && (
        <Card>
          <CardHeader>
            <CardTitle>Saved: {saved.title}</CardTitle>
            <CardDescription>ISBN {saved.isbn}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {saved.hasCover ? (
              <p className="text-sm">Cover attached from this device.</p>
            ) : isLocalhost ? (
              <p className="text-sm text-amber-600">
                No cover attached yet. The QR handoff needs this page open via
                your laptop's LAN IP (not <code>localhost</code>) so your
                phone can reach it - reopen this page at{" "}
                <code>http://&lt;your-laptop-ip&gt;:5173/admin/add-book</code>{" "}
                to use it.
              </p>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm">
                  No cover yet - scan this with your phone to add one:
                </p>
                <div className="rounded border bg-white p-3">
                  <QRCodeSVG value={coverUploadUrl} size={180} />
                </div>
                <p className="text-muted-foreground text-xs break-all">
                  {coverUploadUrl}
                </p>
              </div>
            )}
            <Button onClick={resetForm} className="w-full">
              Scan next book
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
