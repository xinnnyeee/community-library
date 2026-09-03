/**
 * Canonical book categories (finalized 2026-08-27 categorization proposal).
 * Single-select, shown as a dropdown wherever a book's category is set or
 * filtered on, so the value in the `books.category` column always matches
 * one of these exactly (no free-text drift).
 */
export const BOOK_CATEGORIES = [
  "Singapore Lit",
  "Fiction",
  "History",
  "Arts & Language",
  "Philosophy",
  "Classics",
  "Science & Tech",
  "Society & Culture",
  "Politics & Economics",
  "Reference",
] as const;

export type BookCategory = (typeof BOOK_CATEGORIES)[number];

export function isValidBookCategory(value: string): value is BookCategory {
  return (BOOK_CATEGORIES as readonly string[]).includes(value);
}
