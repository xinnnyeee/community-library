/// <reference types="../worker-configuration.d.ts" />
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { botApp } from "./bot.ts";
import { adminBooks } from "./routes/admin-books.ts";
import { manageBooks } from "./routes/manage-books.ts";
import * as schema from "./db/schema.ts";
import { miniApp } from "./routes/mini-app.ts";

const app = new Hono<{
  Bindings: Env;
}>();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const route = app
  .basePath("/api")
  .get("/books", async (c) => {
    const db = drizzle(c.env.DATABASE, {
      schema,
    });

    const books = await db.query.books.findMany({
      columns: {
        id: true,
        isbn: true,
        title: true,
        author: true,
        imageUrl: true,
        createdAt: true,
        description: false,
      },
    });

    return c.json({ books });
  })
  .get("/books/:id", async (c) => {
    const db = drizzle(c.env.DATABASE, {
      schema,
    });

    const bookId = parseInt(c.req.param("id"));

    const book = await db.query.books.findFirst({
      where: eq(schema.books.id, bookId),
      with: {
        bookCopies: {
          with: {
            loans: {
              where: isNull(schema.loans.returnedAt),
            },
            location: true,
          },
        },
      },
    });

    if (!book) {
      return c.json({ error: "Book not found" }, 404);
    }

    return c.json({ book });
  })
  .get("/copies/:qrCodeId", async (c) => {
    const db = drizzle(c.env.DATABASE, {
      schema,
    });
    const qrCodeId = c.req.param("qrCodeId");

    const bookCopy = await db.query.bookCopies.findFirst({
      where: eq(schema.bookCopies.qrCodeId, qrCodeId),
      with: {
        book: true,
        location: true,
        loans: {
          where: isNull(schema.loans.returnedAt),
        },
      },
    });

    if (!bookCopy) {
      return c.json({ error: "Book copy not found" }, 404);
    }
    const { book, ...copy } = bookCopy;

    return c.json({ book, copy });
  })
  .route("/bot", botApp)
  .route("/miniapp", miniApp)
  .route("/admin/books", adminBooks)
  .route("/admin/manage-books", manageBooks);

export default app;
// For type inference in the client
export type AppType = typeof route;
