import { isNull, relations } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const locations = sqliteTable("locations", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
});

export const books = sqliteTable("books", {
  id: integer().primaryKey({ autoIncrement: true }),
  isbn: text().unique().notNull(),
  title: text().notNull(),
  description: text().notNull(),
  author: text().notNull(),
  imageUrl: text("image_url"),
  category: text(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Pool of pre-printed physical QR stickers (COPY-XXXXXX). A code is
// `available` until it's tagged to a book copy, at which point it flips to
// unavailable; removing that copy flips it back to available so the sticker
// can be reused on a different physical book.
export const qrCodes = sqliteTable("qr_codes", {
  code: text().primaryKey(),
  available: integer({ mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookCopies = sqliteTable("book_copies", {
  qrCodeId: text("qr_code_id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id),
  copyNumber: integer("copy_number").notNull(),
  status: text().default("available"),
});

export const loans = sqliteTable(
  "loans",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    qrCodeId: text("qr_code_id")
      .notNull()
      .references(() => bookCopies.qrCodeId),
    telegramUserId: integer("telegram_user_id").notNull(),
    telegramUsername: text("telegram_username"),
    borrowedAt: integer("borrowed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    dueDate: integer("due_date", { mode: "timestamp" }).notNull(),
    returnedAt: integer("returned_at", { mode: "timestamp" }),
    lastReminderSent: integer("last_reminder_sent", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_active_loans").on(table.qrCodeId, table.returnedAt),
    // Unique partial index to prevent concurrent borrowing of the same book copy
    // Only one active loan (returnedAt IS NULL) can exist per qrCodeId
    uniqueIndex("idx_unique_active_loan")
      .on(table.qrCodeId, table.returnedAt)
      .where(isNull(table.returnedAt)),
  ],
);

export const locationsRelations = relations(locations, ({ many }) => ({
  bookCopies: many(bookCopies),
}));

export const booksRelations = relations(books, ({ many }) => ({
  bookCopies: many(bookCopies),
}));

export const bookCopiesRelations = relations(bookCopies, ({ one, many }) => ({
  book: one(books, {
    fields: [bookCopies.bookId],
    references: [books.id],
  }),
  location: one(locations, {
    fields: [bookCopies.locationId],
    references: [locations.id],
  }),
  loans: many(loans),
}));

export const loansRelations = relations(loans, ({ one }) => ({
  bookCopy: one(bookCopies, {
    fields: [loans.qrCodeId],
    references: [bookCopies.qrCodeId],
  }),
}));
