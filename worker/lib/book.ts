import { and, desc, eq, isNull, like, max, or } from "drizzle-orm";
import { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { bookCopies, books, loans, locations, qrCodes } from "../db/schema";

// Type for database with schema
export type Database = DrizzleD1Database<typeof schema>;

// ============================================================================
// BACKEND FUNCTIONS
// ============================================================================

/**
 * Get book copy details with joined book info and current loan status
 * Used by /borrow command
 */
export async function getBookCopyDetails(db: Database, qrCodeId: string) {
  const bookCopy = await db.query.bookCopies.findFirst({
    where: eq(bookCopies.qrCodeId, qrCodeId),
    with: {
      book: true,
      loans: {
        where: isNull(loans.returnedAt),
        limit: 1,
      },
      location: true,
    },
  });

  if (!bookCopy) {
    return null;
  }

  return {
    qrCodeId: bookCopy.qrCodeId,
    copyNumber: bookCopy.copyNumber,
    status: bookCopy.status,
    book: bookCopy.book,
    currentLoan: bookCopy.loans[0] || null,
    location: bookCopy.location.name,
  };
}

/**
 * Get book details by ISBN with all copies and their availability
 * Used by /book command
 */
export async function getBookDetails(db: Database, isbn: string) {
  const book = await db.query.books.findFirst({
    where: eq(books.isbn, isbn),
    with: {
      bookCopies: {
        with: {
          loans: {
            where: isNull(loans.returnedAt),
            limit: 1,
          },
          location: true,
        },
      },
    },
  });

  if (!book) {
    return null;
  }

  // Calculate availability summary
  const totalCopies = book.bookCopies.length;
  const availableCopies = book.bookCopies.filter(
    (copy) => copy.status === "available" && copy.loans.length === 0,
  ).length;

  // Map copies with their loan info (but don't expose QR codes)
  const copiesInfo = book.bookCopies.map((copy) => ({
    copyNumber: copy.copyNumber,
    status: copy.status,
    isAvailable: copy.status === "available" && copy.loans.length === 0,
    dueDate: copy.loans[0]?.dueDate || null,
    location: copy.location.name,
  }));

  return {
    id: book.id,
    isbn: book.isbn,
    title: book.title,
    author: book.author,
    description: book.description,
    imageUrl: book.imageUrl,
    totalCopies,
    availableCopies,
    copies: copiesInfo,
  };
}

/**
 * Borrow a book copy
 * Handles concurrency checks and loan creation
 *
 * NOTE: Cloudflare D1 does not support SQL transaction syntax (BEGIN TRANSACTION, SAVEPOINT).
 * Instead, we rely on a unique partial index on (qrCodeId, returnedAt) WHERE returnedAt IS NULL
 * to ensure that only one active loan can exist per book copy. If two users try to borrow
 * simultaneously, the database constraint will cause one insert to fail, preventing race conditions.
 */
export async function borrowBook(
  db: Database,
  qrCodeId: string,
  telegramUserId: number,
  telegramUsername: string | undefined,
) {
  // 1. Verify book copy exists and is available
  const bookCopy = await db.query.bookCopies.findFirst({
    where: eq(bookCopies.qrCodeId, qrCodeId),
    with: {
      book: true,
      loans: {
        where: isNull(loans.returnedAt),
        limit: 1,
      },
    },
  });

  if (!bookCopy) {
    return { success: false, error: "Book copy not found" };
  }

  if (bookCopy.loans.length > 0) {
    const currentLoan = bookCopy.loans[0];
    if (currentLoan.telegramUserId === telegramUserId) {
      return { success: false, error: "You have already borrowed this book" };
    }
    return {
      success: false,
      error: `This book is currently borrowed (due back ${new Date(currentLoan.dueDate).toLocaleDateString()})`,
    };
  }

  // 2. Create loan record with concurrency protection via unique constraint
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14); // 2-week loan period

  try {
    const [loan] = await db
      .insert(loans)
      .values({
        qrCodeId,
        telegramUserId,
        telegramUsername: telegramUsername || null,
        borrowedAt: new Date(),
        dueDate,
      })
      .returning();

    return {
      success: true,
      loan,
      book: bookCopy.book,
      copyNumber: bookCopy.copyNumber,
    };
  } catch (error) {
    // If unique constraint fails, someone borrowed it between our check and insert
    console.error(error);
    return {
      success: false,
      error: "This book was just borrowed by someone else. Please try again.",
    };
  }
}

/**
 * Return a book copy
 * Validates the user has an active loan for this book
 *
 * NOTE: See borrowBook() for explanation of D1 transaction limitations.
 * We use conditional updates to ensure safe concurrent operations.
 */
export async function returnBook(
  db: Database,
  qrCodeId: string,
  telegramUserId: number,
) {
  const returnedAt = new Date();

  // Conditional update: only update if returnedAt IS NULL
  const result = await db
    .update(loans)
    .set({ returnedAt })
    .where(
      and(
        eq(loans.qrCodeId, qrCodeId),
        eq(loans.telegramUserId, telegramUserId),
        isNull(loans.returnedAt),
      ),
    )
    .returning();

  if (result.length === 0) {
    return { success: false, error: "No active loan found for this book" };
  }

  const [updatedLoan] = result;

  // Fetch book details
  const bookCopy = await db.query.bookCopies.findFirst({
    where: eq(bookCopies.qrCodeId, qrCodeId),
    with: {
      book: true,
    },
  });

  return {
    success: true,
    book: bookCopy!.book,
    borrowedAt: updatedLoan.borrowedAt,
    returnedAt,
  };
}

/**
 * Search books by title or author
 * Returns books with availability info
 */
export async function searchBooks(
  db: Database,
  query: string,
  limit: number = 10,
) {
  const searchPattern = `%${query}%`;

  // LIKE-based search is acceptable here since we're dealing with hundreds of books.
  // Full table scans are fast at this scale (~milliseconds), and this approach keeps
  // the codebase simple without needing FTS5 or additional indexes. We can revisit
  // if the library grows to thousands of books or if search performance / number of row
  // reads becomes an issue.
  const results = await db.query.books.findMany({
    where: or(
      like(books.title, searchPattern),
      like(books.author, searchPattern),
    ),
    limit,
    with: {
      bookCopies: {
        with: {
          loans: {
            where: isNull(loans.returnedAt),
            limit: 1,
          },
        },
      },
    },
  });

  // Transform results to include availability
  return results.map((book) => {
    const totalCopies = book.bookCopies.length;
    const availableCopies = book.bookCopies.filter(
      (copy) => copy.status === "available" && copy.loans.length === 0,
    ).length;

    return {
      isbn: book.isbn,
      title: book.title,
      author: book.author,
      imageUrl: book.imageUrl,
      totalCopies,
      availableCopies,
    };
  });
}

/**
 * Get all active loans for a user
 * Used by /mybooks command
 */
export async function getUserActiveLoans(db: Database, telegramUserId: number) {
  const activeLoans = await db.query.loans.findMany({
    where: and(
      eq(loans.telegramUserId, telegramUserId),
      isNull(loans.returnedAt),
    ),
    with: {
      bookCopy: {
        with: {
          book: true,
        },
      },
    },
    orderBy: [desc(loans.borrowedAt)],
  });

  return activeLoans.map((loan) => ({
    qrCodeId: loan.qrCodeId,
    title: loan.bookCopy.book.title,
    author: loan.bookCopy.book.author,
    copyNumber: loan.bookCopy.copyNumber,
    borrowedAt: loan.borrowedAt,
    dueDate: loan.dueDate,
    imageUrl: loan.bookCopy.book.imageUrl,
  }));
}

/**
 * Get all locations
 */
export async function getAllLocations(db: Database) {
  return db.query.locations.findMany();
}

/**
 * Add a new book copy
 * Automatically assigns the next copy number for the book
 */
export async function addBookCopy(
  db: Database,
  bookId: number,
  locationId: number,
  qrCodeId: string,
): Promise<
  | { success: true; copy: { qrCodeId: string; copyNumber: number } }
  | { success: false; error: string }
> {
  // Verify the book exists
  const book = await db.query.books.findFirst({
    where: eq(books.id, bookId),
  });

  if (!book) {
    return { success: false, error: "Book not found" };
  }

  // Verify the location exists
  const location = await db.query.locations.findFirst({
    where: eq(locations.id, locationId),
  });

  if (!location) {
    return { success: false, error: "Location not found" };
  }

  // Check if QR code is already in use
  const existingCopy = await db.query.bookCopies.findFirst({
    where: eq(bookCopies.qrCodeId, qrCodeId),
  });

  if (existingCopy) {
    return { success: false, error: "QR code is already assigned to a book" };
  }

  // Get the next copy number for this book
  const maxCopyResult = await db
    .select({ maxCopyNumber: max(bookCopies.copyNumber) })
    .from(bookCopies)
    .where(eq(bookCopies.bookId, bookId));

  const nextCopyNumber = (maxCopyResult[0]?.maxCopyNumber ?? 0) + 1;

  // Insert the new copy
  try {
    await db.insert(bookCopies).values({
      qrCodeId,
      bookId,
      locationId,
      copyNumber: nextCopyNumber,
      status: "available",
    });

    // Flip the QR sticker to unavailable in the pool table so it isn't
    // handed out again for a different book. Upsert in case this code
    // predates the qr_codes backfill and isn't in the pool yet.
    await db
      .insert(qrCodes)
      .values({ code: qrCodeId, available: false })
      .onConflictDoUpdate({
        target: qrCodes.code,
        set: { available: false },
      });

    return {
      success: true,
      copy: { qrCodeId, copyNumber: nextCopyNumber },
    };
  } catch (error) {
    console.error("Failed to add book copy:", error);
    return { success: false, error: "Failed to add book copy" };
  }
}

/**
 * Remove a book copy (e.g. lost/damaged sticker, or as part of removing the
 * whole book from the catalog). Frees the QR sticker back to the pool so it
 * can be reused on a different physical book. Blocks removal while there's
 * an active (unreturned) loan against this copy, since that would silently
 * orphan a book that's still physically checked out.
 */
export async function removeBookCopy(
  db: Database,
  qrCodeId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const activeLoan = await db.query.loans.findFirst({
    where: and(eq(loans.qrCodeId, qrCodeId), isNull(loans.returnedAt)),
  });

  if (activeLoan) {
    return {
      success: false,
      error:
        "This copy has an active loan - it must be returned before the copy can be removed.",
    };
  }

  try {
    // No active loan (checked above), but there may be returned/historical
    // loan rows referencing this copy - the loans table has a foreign key on
    // qr_code_id, so those must go before the copy row can be deleted.
    // This does mean historical borrow records for this specific copy are
    // lost, not just the copy itself.
    await db.delete(loans).where(eq(loans.qrCodeId, qrCodeId));
    await db.delete(bookCopies).where(eq(bookCopies.qrCodeId, qrCodeId));

    await db
      .insert(qrCodes)
      .values({ code: qrCodeId, available: true })
      .onConflictDoUpdate({
        target: qrCodes.code,
        set: { available: true },
      });

    return { success: true };
  } catch (error) {
    console.error("Failed to remove book copy:", error);
    return { success: false, error: "Failed to remove book copy" };
  }
}
