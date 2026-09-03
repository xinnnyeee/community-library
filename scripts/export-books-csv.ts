/**
 * Regenerates exports/books.csv from the local D1 database.
 *
 * The "Add New Book" admin page (/admin/add-book) writes directly to the local
 * D1 database - Cloudflare Workers can't write files to your disk, so it can't
 * update books.csv itself. Run this afterwards whenever you want a fresh CSV
 * snapshot of the full `books` table:
 *
 *   bun run scripts/export-books-csv.ts
 *
 * This only reads from the database and only writes exports/books.csv - it
 * never modifies the database itself.
 */

import { $ } from "bun";
import { writeCSV } from "./lib/csv";

interface BookRow {
  id: number;
  isbn: string;
  title: string;
  description: string;
  author: string;
  image_url: string | null;
  category: string | null;
  created_at: number;
}

async function main() {
  const result =
    await $`bunx wrangler d1 execute community-library-db --local --json --command="SELECT id, isbn, title, description, author, image_url, category, created_at FROM books ORDER BY id"`.text();

  // wrangler sometimes prints warnings (e.g. proxy detection) before the JSON
  // output - find where the actual JSON array starts.
  const jsonStart = result.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`Unexpected wrangler output (no JSON found):\n${result}`);
  }
  const parsed = JSON.parse(result.slice(jsonStart)) as Array<{
    results: BookRow[];
  }>;
  const rows = parsed[0]?.results ?? [];

  await writeCSV("exports/books.csv", rows, [
    "id",
    "isbn",
    "title",
    "description",
    "author",
    "image_url",
    "category",
    "created_at",
  ]);

  console.log(`Wrote ${rows.length} books to exports/books.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
