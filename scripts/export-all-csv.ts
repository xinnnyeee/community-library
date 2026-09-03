/**
 * Exports every application table in the local D1 database to its own CSV
 * under exports/ - a snapshot of the whole database, not just books.
 *
 * This only reads from the database and only writes to exports/*.csv - it
 * never modifies the database itself.
 *
 *   bun run export-all-csv
 *
 * Add a table here (name + column list, in the order you want the CSV
 * columns) whenever a new table is added to worker/db/schema.ts.
 */

import { writeCSV } from "./lib/csv";

const TABLES: Record<string, string[]> = {
  books: [
    "id",
    "isbn",
    "title",
    "description",
    "author",
    "image_url",
    "category",
    "created_at",
  ],
  book_copies: ["qr_code_id", "book_id", "location_id", "copy_number", "status"],
  loans: [
    "id",
    "qr_code_id",
    "telegram_user_id",
    "telegram_username",
    "borrowed_at",
    "due_date",
    "returned_at",
    "last_reminder_sent",
  ],
  locations: ["id", "name"],
  qr_codes: ["code", "available", "created_at"],
};

async function exportTable(table: string, columns: string[]): Promise<number> {
  const sql = `SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`;

  // Bun.spawn with an argv array (not the `$` shell template) so the SQL
  // string is passed straight through as one argument - no shell quoting to
  // get wrong, regardless of what's inside it.
  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "community-library-db",
      "--local",
      "--json",
      "--command",
      sql,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`wrangler failed for table "${table}":\n${stderr}`);
  }

  // wrangler sometimes prints warnings (e.g. proxy detection) before the JSON
  // output - find where the actual JSON array starts.
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(
      `Unexpected wrangler output for table "${table}" (no JSON found):\n${stdout}`,
    );
  }
  const parsed = JSON.parse(stdout.slice(jsonStart)) as Array<{
    results: Record<string, unknown>[];
  }>;
  const rows = parsed[0]?.results ?? [];

  await writeCSV(`exports/${table}.csv`, rows, columns);
  return rows.length;
}

async function main() {
  for (const [table, columns] of Object.entries(TABLES)) {
    const count = await exportTable(table, columns);
    console.log(`Wrote ${count} rows to exports/${table}.csv`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
