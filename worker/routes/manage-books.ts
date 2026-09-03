import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeISBN } from "../../scripts/lib/isbn";
import { BOOK_CATEGORIES } from "../../shared/categories";
import * as schema from "../db/schema";
import { addBookCopy, removeBookCopy, type Database } from "../lib/book";

/**
 * Admin "manage books" page: search/filter the catalog, edit book details
 * (including category), and remove books or individual copies.
 *
 * Removing a book also removes all of its book_copies (and their loan
 * history) and frees the corresponding QR stickers back to the pool -
 * unless one of its copies has an active (unreturned) loan, in which case
 * the whole removal is blocked so a book that's still checked out is never
 * silently deleted out from under a borrower.
 *
 * Not gated behind Telegram admin auth (unlike the mini-app routes) - like
 * admin-books.ts, this is meant to be run locally by an admin on `bun run dev`.
 */

const categoryEnum = z.enum(BOOK_CATEGORIES);

export const manageBooks = new Hono<{ Bindings: Env }>()
  // List + search + filter. Query params are all optional:
  //   q          - matches ISBN or title (substring, case-insensitive-ish via LIKE)
  //   category   - exact match against BOOK_CATEGORIES
  //   locationId - only books with at least one copy at this location
  .get("/", async (c) => {
    const q = c.req.query("q")?.trim();
    const category = c.req.query("category");
    const locationIdRaw = c.req.query("locationId");
    const locationId = locationIdRaw ? Number(locationIdRaw) : undefined;

    const db = drizzle(c.env.DATABASE, { schema });

    const conditions = [];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        or(like(schema.books.isbn, pattern), like(schema.books.title, pattern)),
      );
    }
    if (category) {
      conditions.push(eq(schema.books.category, category));
    }

    const rows = await db.query.books.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: (books, { desc }) => [desc(books.createdAt)],
      with: {
        bookCopies: {
          with: {
            location: true,
            loans: { where: isNull(schema.loans.returnedAt), limit: 1 },
          },
        },
      },
    });

    // locationId filters on a joined child table - simplest to apply in JS
    // at this scale (hundreds of books, same tradeoff searchBooks() already
    // makes in worker/lib/book.ts).
    const filtered = locationId
      ? rows.filter((book) =>
          book.bookCopies.some((copy) => copy.locationId === locationId),
        )
      : rows;

    return c.json({
      books: filtered.map((book) => ({
        id: book.id,
        isbn: book.isbn,
        title: book.title,
        author: book.author,
        description: book.description,
        imageUrl: book.imageUrl,
        category: book.category,
        createdAt: book.createdAt,
        copies: book.bookCopies.map((copy) => ({
          qrCodeId: copy.qrCodeId,
          copyNumber: copy.copyNumber,
          status: copy.status,
          location: copy.location ? { id: copy.location.id, name: copy.location.name } : null,
          onLoan: copy.loans.length > 0,
        })),
      })),
    });
  })
  // Locations + categories for the filter dropdowns / edit form.
  .get("/filters", async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const locations = await db.query.locations.findMany();
    return c.json({ locations, categories: BOOK_CATEGORIES });
  })
  // Edit a single book's details.
  .patch(
    "/:isbn",
    zValidator(
      "form",
      z.object({
        title: z.string().min(1).optional(),
        author: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        category: categoryEnum.optional(),
      }),
    ),
    async (c) => {
      const isbn = normalizeISBN(c.req.param("isbn"));
      if (!isbn) {
        return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
      }

      const updates = c.req.valid("form");
      if (Object.keys(updates).length === 0) {
        return c.json({ error: "No fields to update" }, 400);
      }

      const db = drizzle(c.env.DATABASE, { schema });
      const [updated] = await db
        .update(schema.books)
        .set(updates)
        .where(eq(schema.books.isbn, isbn))
        .returning();

      if (!updated) {
        return c.json({ error: "No book with this ISBN" }, 404);
      }

      return c.json({ book: updated });
    },
  )
  // Batch edit (currently: category only) across multiple ISBNs at once.
  .post(
    "/batch-edit",
    zValidator(
      "json",
      z.object({
        isbns: z.array(z.string()).min(1),
        category: categoryEnum,
      }),
    ),
    async (c) => {
      const { isbns, category } = c.req.valid("json");
      const db = drizzle(c.env.DATABASE, { schema });

      const updated = await db
        .update(schema.books)
        .set({ category })
        .where(inArray(schema.books.isbn, isbns))
        .returning({ isbn: schema.books.isbn });

      return c.json({ updatedCount: updated.length });
    },
  )
  // Remove a single book and all of its copies (loan-guarded, see module docstring).
  .delete("/:isbn", async (c) => {
    const isbn = normalizeISBN(c.req.param("isbn"));
    if (!isbn) {
      return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const result = await removeBookAndCopies(db, isbn);
    if (!result.success) {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ success: true });
  })
  // Batch remove. Reports which ISBNs were actually removed vs blocked
  // (e.g. by an active loan on one of their copies) rather than
  // half-failing silently.
  .post(
    "/batch-remove",
    zValidator("json", z.object({ isbns: z.array(z.string()).min(1) })),
    async (c) => {
      const { isbns } = c.req.valid("json");
      const db = drizzle(c.env.DATABASE, { schema });

      const removed: string[] = [];
      const blocked: { isbn: string; error: string }[] = [];

      for (const isbn of isbns) {
        const result = await removeBookAndCopies(db, isbn);
        if (result.success) {
          removed.push(isbn);
        } else {
          blocked.push({ isbn, error: result.error });
        }
      }

      return c.json({ removed, blocked });
    },
  )
  // Add a new copy of a book. The QR code must be typed/scanned from the
  // physical sticker actually being placed on this book - it's checked
  // against the qr_codes pool and rejected if that sticker is already
  // tagged to another book. Never touches the `books` row itself, even
  // though the book previously had zero copies.
  .post(
    "/:isbn/copies",
    zValidator(
      "json",
      z.object({
        locationId: z.number().int(),
        qrCodeId: z.string().min(1),
      }),
    ),
    async (c) => {
      const isbn = normalizeISBN(c.req.param("isbn"));
      if (!isbn) {
        return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
      }

      const { locationId, qrCodeId } = c.req.valid("json");
      const db = drizzle(c.env.DATABASE, { schema });

      const book = await db.query.books.findFirst({
        where: eq(schema.books.isbn, isbn),
      });
      if (!book) {
        return c.json({ error: "No book with this ISBN" }, 404);
      }

      const poolEntry = await db.query.qrCodes.findFirst({
        where: eq(schema.qrCodes.code, qrCodeId),
      });
      if (poolEntry && !poolEntry.available) {
        return c.json(
          { error: `${qrCodeId} is already tagged to another book copy` },
          409,
        );
      }

      const result = await addBookCopy(db, book.id, locationId, qrCodeId);
      if (!result.success) {
        return c.json({ error: result.error }, 409);
      }

      return c.json({ copy: result.copy });
    },
  )
  // Reassign a copy's location. Only ever touches this one book_copies row -
  // never the parent `books` row.
  .patch(
    "/copies/:qrCodeId",
    zValidator("json", z.object({ locationId: z.number().int() })),
    async (c) => {
      const qrCodeId = c.req.param("qrCodeId");
      const { locationId } = c.req.valid("json");
      const db = drizzle(c.env.DATABASE, { schema });

      const location = await db.query.locations.findFirst({
        where: eq(schema.locations.id, locationId),
      });
      if (!location) {
        return c.json({ error: "Location not found" }, 404);
      }

      const [updated] = await db
        .update(schema.bookCopies)
        .set({ locationId })
        .where(eq(schema.bookCopies.qrCodeId, qrCodeId))
        .returning();

      if (!updated) {
        return c.json({ error: "No copy with this QR code" }, 404);
      }

      return c.json({ copy: { ...updated, location } });
    },
  )
  // Remove a single physical copy (frees its QR sticker back to the pool).
  .delete("/copies/:qrCodeId", async (c) => {
    const qrCodeId = c.req.param("qrCodeId");
    const db = drizzle(c.env.DATABASE, { schema });
    const result = await removeBookCopy(db, qrCodeId);
    if (!result.success) {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ success: true });
  });

/**
 * Shared by the single- and batch-remove routes: deletes every copy of the
 * book (via removeBookCopy, which itself guards against active loans and
 * frees each QR sticker), then the book row itself. Bails out - leaving
 * everything untouched - the moment any copy can't be removed, rather than
 * partially deleting a book's copies.
 */
async function removeBookAndCopies(
  db: Database,
  isbn: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const book = await db.query.books.findFirst({
    where: eq(schema.books.isbn, isbn),
    with: { bookCopies: true },
  });

  if (!book) {
    return { success: false, error: "No book with this ISBN" };
  }

  for (const copy of book.bookCopies) {
    const result = await removeBookCopy(db, copy.qrCodeId);
    if (!result.success) {
      return {
        success: false,
        error: `Copy ${copy.qrCodeId}: ${result.error}`,
      };
    }
  }

  await db.delete(schema.books).where(eq(schema.books.isbn, isbn));
  return { success: true };
}
