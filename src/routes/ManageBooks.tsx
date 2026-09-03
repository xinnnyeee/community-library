import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { client } from "@/lib/api-client";
import type { BookCategory } from "../../shared/categories";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

/**
 * Admin "manage books" page: search/filter the catalog, edit book details
 * (including category), and remove books or individual physical copies.
 *
 * This is the test surface for the add-book flow - books added via
 * /admin/add-book show up here with zero copies (copies only get linked
 * later via the Telegram mini-app's QR-scan flow), and can be removed from
 * here to reset for another test run.
 */

type Copy = {
  qrCodeId: string;
  copyNumber: number;
  status: string | null;
  location: { id: number; name: string } | null;
  onLoan: boolean;
};

type BookRow = {
  id: number;
  isbn: string;
  title: string;
  author: string;
  description: string;
  imageUrl: string | null;
  category: string | null;
  createdAt: string;
  copies: Copy[];
};

type Location = { id: number; name: string };

const manageBooksApi = client.api.admin["manage-books"];

export default function ManageBooks() {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [locationFilter, setLocationFilter] = useState<string>("all");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<BookRow | null>(null);
  const [removing, setRemoving] = useState<BookRow | null>(null);
  const [removingCopy, setRemovingCopy] = useState<{ book: BookRow; copy: Copy } | null>(null);
  const [batchRemoveOpen, setBatchRemoveOpen] = useState(false);
  const [batchCategory, setBatchCategory] = useState<string>("");

  async function loadFilters() {
    const res = await manageBooksApi.filters.$get();
    const data = await res.json();
    setLocations(data.locations);
    setCategories([...data.categories]);
  }

  async function loadBooks() {
    setLoading(true);
    try {
      const res = await manageBooksApi.$get({
        query: {
          ...(search.trim() ? { q: search.trim() } : {}),
          ...(categoryFilter !== "all" ? { category: categoryFilter } : {}),
          ...(locationFilter !== "all" ? { locationId: locationFilter } : {}),
        },
      });
      const data = await res.json();
      setBooks(data.books);
      setSelected(new Set());
    } catch {
      toast.error("Couldn't reach the server. Is `bun run dev` running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFilters();
  }, []);

  useEffect(() => {
    const handle = setTimeout(loadBooks, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryFilter, locationFilter]);

  const allSelected = books.length > 0 && selected.size === books.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(books.map((b) => b.isbn)));
  }

  function toggleOne(isbn: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(isbn)) next.delete(isbn);
      else next.add(isbn);
      return next;
    });
  }

  async function handleSaveEdit(updates: {
    title: string;
    author: string;
    description: string;
    category: string;
  }) {
    if (!editing) return;
    const res = await manageBooksApi[":isbn"].$patch({
      param: { isbn: editing.isbn },
      form: { ...updates, category: updates.category as BookCategory },
    });
    const data = await res.json();
    if ("error" in data) {
      toast.error(data.error);
      return;
    }
    toast.success(`Updated: ${updates.title}`);
    setEditing(null);
    loadBooks();
  }

  async function handleRemoveBook() {
    if (!removing) return;
    const res = await manageBooksApi[":isbn"].$delete({
      param: { isbn: removing.isbn },
    });
    const data = await res.json();
    if ("error" in data) {
      toast.error(data.error);
      return;
    }
    toast.success(`Removed: ${removing.title}`);
    setRemoving(null);
    loadBooks();
  }

  async function handleRemoveCopy() {
    if (!removingCopy) return;
    const res = await manageBooksApi.copies[":qrCodeId"].$delete({
      param: { qrCodeId: removingCopy.copy.qrCodeId },
    });
    const data = await res.json();
    if ("error" in data) {
      toast.error(data.error);
      return;
    }
    toast.success(`Removed copy ${removingCopy.copy.qrCodeId}`);
    setRemovingCopy(null);
    loadBooks();
  }

  async function handleBatchCategory() {
    if (!batchCategory || selected.size === 0) return;
    const res = await manageBooksApi["batch-edit"].$post({
      json: { isbns: [...selected], category: batchCategory as BookCategory },
    });
    const data = await res.json();
    toast.success(`Updated category on ${data.updatedCount} book(s)`);
    setBatchCategory("");
    loadBooks();
  }

  async function handleBatchRemove() {
    const res = await manageBooksApi["batch-remove"].$post({
      json: { isbns: [...selected] },
    });
    const data = await res.json();
    setBatchRemoveOpen(false);
    if (data.removed.length > 0) {
      toast.success(`Removed ${data.removed.length} book(s)`);
    }
    if (data.blocked.length > 0) {
      toast.error(
        `${data.blocked.length} book(s) couldn't be removed: ${data.blocked
          .map((b) => `${b.isbn} (${b.error})`)
          .join("; ")}`,
      );
    }
    loadBooks();
  }

  const selectedCount = selected.size;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Toaster />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Manage Books</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/add-covers">Add covers</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/add-book">Add new book</Link>
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder="Search by title or ISBN..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={locationFilter} onValueChange={setLocationFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="RC / Location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedCount > 0 && (
        <div className="bg-muted mb-4 flex flex-wrap items-center gap-3 rounded-md border p-3">
          <span className="text-sm font-medium">{selectedCount} selected</span>
          <Select value={batchCategory} onValueChange={setBatchCategory}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Set category to..." />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleBatchCategory} disabled={!batchCategory}>
            Apply category
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBatchRemoveOpen(true)}
          >
            Remove selected
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>ISBN</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Copies</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground text-center">
                  Loading...
                </TableCell>
              </TableRow>
            )}
            {!loading && books.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground text-center">
                  No books match these filters.
                </TableCell>
              </TableRow>
            )}
            {books.map((book) => (
              <BookTableRow
                key={book.isbn}
                book={book}
                locations={locations}
                selected={selected.has(book.isbn)}
                onToggle={() => toggleOne(book.isbn)}
                onEdit={() => setEditing(book)}
                onRemove={() => setRemoving(book)}
                onRemoveCopy={(copy) => setRemovingCopy({ book, copy })}
                onReload={loadBooks}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <EditBookDialog
          book={editing}
          categories={categories}
          onCancel={() => setEditing(null)}
          onSave={handleSaveEdit}
        />
      )}

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{removing?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the book and all {removing?.copies.length ?? 0} of its
              copies, and frees their QR stickers back to the pool. This can't
              be undone. If any copy has an active loan, the removal will be
              blocked instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveBook}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!removingCopy}
        onOpenChange={(open) => !open && setRemovingCopy(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove copy {removingCopy?.copy.qrCodeId}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Frees this QR sticker back to the pool so it can be reused on a
              different book. Blocked if this copy currently has an active loan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveCopy}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={batchRemoveOpen} onOpenChange={setBatchRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {selectedCount} book(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes each selected book and all of its copies, freeing their
              QR stickers. Any book with a copy on active loan will be
              reported as blocked instead of removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBatchRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BookTableRow({
  book,
  locations,
  selected,
  onToggle,
  onEdit,
  onRemove,
  onRemoveCopy,
  onReload,
}: {
  book: BookRow;
  locations: Location[];
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRemoveCopy: (copy: Copy) => void;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [addingCopy, setAddingCopy] = useState(false);

  return (
    <>
      <TableRow>
        <TableCell>
          <Checkbox checked={selected} onCheckedChange={onToggle} />
        </TableCell>
        <TableCell className="font-medium">{book.title}</TableCell>
        <TableCell>{book.author}</TableCell>
        <TableCell className="text-muted-foreground text-sm">{book.isbn}</TableCell>
        <TableCell>
          {book.category ? (
            <Badge variant="secondary">{book.category}</Badge>
          ) : (
            <span className="text-muted-foreground text-sm">-</span>
          )}
        </TableCell>
        <TableCell>
          <button
            className="text-sm underline decoration-dotted underline-offset-2"
            onClick={() => setExpanded((v) => !v)}
          >
            {book.copies.length} {book.copies.length === 1 ? "copy" : "copies"}
          </button>
        </TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant="outline" onClick={onEdit} className="mr-2">
            Edit
          </Button>
          <Button size="sm" variant="destructive" onClick={onRemove}>
            Remove
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell />
          <TableCell colSpan={6}>
            <div className="flex flex-col gap-2">
              {book.copies.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No copies yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {book.copies.map((copy) => (
                    <CopyRow
                      key={copy.qrCodeId}
                      copy={copy}
                      locations={locations}
                      onRemove={() => onRemoveCopy(copy)}
                      onReload={onReload}
                    />
                  ))}
                </ul>
              )}

              {addingCopy ? (
                <AddCopyForm
                  isbn={book.isbn}
                  locations={locations}
                  onCancel={() => setAddingCopy(false)}
                  onAdded={() => {
                    setAddingCopy(false);
                    onReload();
                  }}
                />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => setAddingCopy(true)}
                >
                  + Add copy
                </Button>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function CopyRow({
  copy,
  locations,
  onRemove,
  onReload,
}: {
  copy: Copy;
  locations: Location[];
  onRemove: () => void;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [locationId, setLocationId] = useState(
    copy.location ? String(copy.location.id) : "",
  );
  const [saving, setSaving] = useState(false);

  async function handleSaveLocation() {
    if (!locationId) return;
    setSaving(true);
    try {
      const res = await manageBooksApi.copies[":qrCodeId"].$patch({
        param: { qrCodeId: copy.qrCodeId },
        json: { locationId: Number(locationId) },
      });
      const data = await res.json();
      if ("error" in data) {
        toast.error(data.error);
        return;
      }
      toast.success(`Moved ${copy.qrCodeId}`);
      setEditing(false);
      onReload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="flex items-center gap-2">
        #{copy.copyNumber} - {copy.qrCodeId} -{" "}
        {editing ? (
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="h-7 w-32">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{copy.location?.name ?? "no location"}</span>
        )}
        {copy.onLoan && (
          <Badge variant="outline" className="ml-1">
            On loan
          </Badge>
        )}
      </span>
      <span className="flex items-center gap-1">
        {editing ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={handleSaveLocation}
              disabled={saving || !locationId}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive h-7"
          onClick={onRemove}
        >
          Remove copy
        </Button>
      </span>
    </li>
  );
}

function AddCopyForm({
  isbn,
  locations,
  onCancel,
  onAdded,
}: {
  isbn: string;
  locations: Location[];
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [qrCodeId, setQrCodeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!qrCodeId.trim() || !locationId) return;
    setSaving(true);
    try {
      const res = await manageBooksApi[":isbn"].copies.$post({
        param: { isbn },
        json: { qrCodeId: qrCodeId.trim(), locationId: Number(locationId) },
      });
      const data = await res.json();
      if ("error" in data) {
        toast.error(data.error);
        return;
      }
      toast.success(`Added copy ${qrCodeId.trim()}`);
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-muted flex flex-wrap items-center gap-2 rounded-md border p-2">
      <Input
        placeholder="Scan/type the QR code on the sticker (e.g. COPY-ABC123)"
        value={qrCodeId}
        onChange={(e) => setQrCodeId(e.target.value.toUpperCase())}
        className="h-8 max-w-64"
        autoComplete="off"
      />
      <Select value={locationId} onValueChange={setLocationId}>
        <SelectTrigger className="h-8 w-32">
          <SelectValue placeholder="Location" />
        </SelectTrigger>
        <SelectContent>
          {locations.map((l) => (
            <SelectItem key={l.id} value={String(l.id)}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        onClick={handleAdd}
        disabled={saving || !qrCodeId.trim() || !locationId}
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
    </div>
  );
}

function EditBookDialog({
  book,
  categories,
  onCancel,
  onSave,
}: {
  book: BookRow;
  categories: string[];
  onCancel: () => void;
  onSave: (updates: {
    title: string;
    author: string;
    description: string;
    category: string;
  }) => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [description, setDescription] = useState(book.description);
  const [category, setCategory] = useState(book.category ?? "");

  const canSave = useMemo(
    () => title.trim() && author.trim() && description.trim() && category,
    [title, author, description, category],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit book</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-author">Author</Label>
            <Input id="edit-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              onSave({
                title: title.trim(),
                author: author.trim(),
                description: description.trim(),
                category,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
