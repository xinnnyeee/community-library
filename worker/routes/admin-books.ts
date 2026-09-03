import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeISBN } from "../../scripts/lib/isbn";
import { BOOK_CATEGORIES } from "../../shared/categories";
import * as schema from "../db/schema";
import { uploadCoverToGithub } from "../lib/github-covers";
import { lookupGoogleBooks } from "../lib/google-books";

/**
 * Admin "add new book" flow: scan ISBN -> Google Books lookup -> save -> cover.
 *
 * This route only ever INSERTS new rows into `books`, with one narrow exception:
 * POST /:isbn/cover, which sets/replaces that one book's own image_url right
 * after it was created. It never touches any other book, copy, loan, or location.
 *
 * Not gated behind Telegram admin auth (unlike the mini-app routes) - this is
 * meant to be run locally by whoever is scanning in new books, on `bun run dev`.
 */
export const adminBooks = new Hono<{ Bindings: Env }>()
  // Step 1+2: given a scanned ISBN, check for a duplicate and fetch Google Books info.
  .get("/lookup/:isbn", async (c) => {
    const isbn = normalizeISBN(c.req.param("isbn"));
    if (!isbn) {
      return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const existing = await db.query.books.findFirst({
      where: eq(schema.books.isbn, isbn),
    });

    if (existing) {
      return c.json({
        isbn,
        duplicate: true,
        existing,
        google: null,
        googleError: null,
      });
    }

    const lookup = await lookupGoogleBooks(isbn, c.env.GOOGLE_BOOKS_API_KEY);
    if (!lookup.ok) {
      return c.json({
        isbn,
        duplicate: false,
        existing: null,
        google: null,
        googleError: lookup.error,
      });
    }

    return c.json({
      isbn,
      duplicate: false,
      existing: null,
      google: lookup.data,
      googleError: null,
    });
  })
  // Step 3: save the (possibly-edited) book details. Cover is optional here -
  // it can be attached immediately from this device, or later via the QR-code
  // handoff to /:isbn/cover from a phone.
  .post(
    "/",
    zValidator(
      "form",
      z.object({
        isbn: z.string(),
        title: z.string().min(1, "Title is required"),
        author: z.string().min(1, "Author is required"),
        description: z.string().optional(),
        category: z.enum(BOOK_CATEGORIES).optional(),
        cover: z.instanceof(File).optional(),
      }),
    ),
    async (c) => {
      const { isbn: rawIsbn, title, author, description, category, cover } =
        c.req.valid("form");

      const isbn = normalizeISBN(rawIsbn);
      if (!isbn) {
        return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
      }

      const db = drizzle(c.env.DATABASE, { schema });

      const existing = await db.query.books.findFirst({
        where: eq(schema.books.isbn, isbn),
      });
      if (existing) {
        return c.json(
          { error: "A book with this ISBN is already in the catalog", existing },
          409,
        );
      }

      let imageUrl: string | null = null;
      if (cover && cover.size > 0) {
        imageUrl = await pushCover(c.env, isbn, cover);
        if (imageUrl === null) {
          return c.json(
            {
              error:
                "GITHUB_TOKEN / GITHUB_IMAGES_REPO are not set in .dev.vars - cover upload is unavailable",
            },
            500,
          );
        }
      }

      const [book] = await db
        .insert(schema.books)
        .values({
          isbn,
          title,
          author,
          description: description?.trim() || "No description available",
          imageUrl,
          category: category ?? null,
        })
        .returning();

      return c.json({ book });
    },
  )
  // Used by the phone-side cover page to show which book it's uploading a cover for.
  .get("/:isbn", async (c) => {
    const isbn = normalizeISBN(c.req.param("isbn"));
    if (!isbn) {
      return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const book = await db.query.books.findFirst({
      where: eq(schema.books.isbn, isbn),
    });

    if (!book) {
      return c.json({ error: "No book with this ISBN yet - save it from the laptop first" }, 404);
    }

    return c.json({ book });
  })
  // Step 4 (QR handoff target): set/replace this one book's cover image.
  // Scanned from the laptop's QR code, typically opened on a phone.
  .post(
    "/:isbn/cover",
    zValidator("form", z.object({ cover: z.instanceof(File) })),
    async (c) => {
      const isbn = normalizeISBN(c.req.param("isbn"));
      if (!isbn) {
        return c.json({ error: "That doesn't look like a valid ISBN-10/13" }, 400);
      }

      const db = drizzle(c.env.DATABASE, { schema });
      const book = await db.query.books.findFirst({
        where: eq(schema.books.isbn, isbn),
      });
      if (!book) {
        return c.json({ error: "No book with this ISBN yet - save it from the laptop first" }, 404);
      }

      const { cover } = c.req.valid("form");
      const imageUrl = await pushCover(c.env, isbn, cover);
      if (imageUrl === null) {
        return c.json(
          {
            error:
              "GITHUB_TOKEN / GITHUB_IMAGES_REPO are not set in .dev.vars - cover upload is unavailable",
          },
          500,
        );
      }

      const [updated] = await db
        .update(schema.books)
        .set({ imageUrl })
        .where(eq(schema.books.isbn, isbn))
        .returning();

      return c.json({ book: updated });
    },
  );

/**
 * Uploads a cover file to the GitHub images repo and returns the resulting
 * CDN URL, or null if GITHUB_TOKEN / GITHUB_IMAGES_REPO aren't configured.
 */
async function pushCover(
  env: Env,
  isbn: string,
  cover: File,
): Promise<string | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_IMAGES_REPO) {
    return null;
  }
  const webpBytes = new Uint8Array(await cover.arrayBuffer());
  const { cdnUrl } = await uploadCoverToGithub({
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_IMAGES_REPO,
    isbn,
    webpBytes,
  });
  return cdnUrl;
}
