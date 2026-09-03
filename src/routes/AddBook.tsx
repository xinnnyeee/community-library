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
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

/**
 * Admin tool: scan ISBN -> Google Books lookup -> save. Deliberately fast
 * and repetitive - the point is to get through a stack of books quickly,
 * one scan after another, with no per-book cover step in the way.
 *
 * Workflow:
 *  1. Focus (and any leftover text selection) stays on the ISBN field between
 *     scans. A USB barcode scanner "types" the ISBN and presses Enter for
 *     you, which triggers step 2 automatically.
 *  2. We look up the ISBN against Google Books (and check for an existing
 *     book with the same ISBN so we never create a duplicate).
 *  3. The fetched title/author/description are shown, editable. Saving
 *     inserts ONE new row into `books` - no cover, no QR handoff to a phone
 *     - and immediately resets back to step 1, focused and ready for the
 *     next scan. Covers get attached afterwards, one at a time or in bulk,
 *     from /admin/add-covers.
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

export default function AddBook() {
  const isbnInputRef = useRef<HTMLInputElement>(null);
  const [isbnInput, setIsbnInput] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ status: "idle" });

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<BookCategory | "">("");

  const [saving, setSaving] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  useEffect(() => {
    refocusIsbnInput();
  }, []);

  function resetForm() {
    setIsbnInput("");
    setLookup({ status: "idle" });
    setTitle("");
    setAuthor("");
    setDescription("");
    setCategory("");
    refocusIsbnInput();
  }

  /**
   * A USB barcode scanner just sends raw keystrokes to whatever currently has
   * focus. After "Look up" is clicked, the browser moves focus to that button
   * - so scanning the next book's barcode would type into nothing, and its
   * trailing Enter would just re-click "Look up" and resubmit the OLD ISBN
   * still sitting in the field. Call this on mount, after every lookup
   * result, and after every save, so focus (and a full text selection, so
   * the next scan overwrites rather than appends) is always back on the
   * ISBN field, ready for the next scan.
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
      const res = await client.api.admin.books.$post({
        form: {
          isbn,
          title: title.trim(),
          author: author.trim(),
          description: description.trim() || "No description available",
          ...(category ? { category } : {}),
        },
      });
      const data = await res.json();

      if ("error" in data) {
        toast.error(data.error);
        return;
      }

      setAddedCount((n) => n + 1);
      toast.success(`Added: ${title}`);
      resetForm();
    } catch {
      toast.error("Couldn't reach the server. Is `bun run dev` running?");
    } finally {
      setSaving(false);
    }
  }

  const showDetailsForm =
    lookup.status === "found" ||
    lookup.status === "not-found" ||
    lookup.status === "lookup-failed";

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

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>1. Scan ISBN</CardTitle>
          <CardDescription>
            Focus stays here between scans - a USB barcode scanner will type
            the ISBN and press Enter for you. Covers aren't handled here;
            catch them up afterwards from /admin/add-covers.
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
              autoFocus
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
        <Button onClick={handleSave} disabled={saving} className="w-full">
          {saving ? "Saving..." : "3. Save book"}
        </Button>
      )}
    </div>
  );
}
