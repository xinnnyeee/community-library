/**
 * One-time backfill: populates the `qr_codes` pool table from the pre-printed
 * QR sticker batches (qr-codes/codes-batch-*.txt) and marks each code
 * available/unavailable based on whether it's already linked to a book_copies
 * row in the local D1 database.
 *
 * Safe to re-run: uses INSERT ... ON CONFLICT DO NOTHING, so it never
 * overwrites a qr_codes row that's already there (e.g. one flipped
 * unavailable since the last run via the app itself).
 *
 * Run once after applying the `add_category_and_qr_pool` migration:
 *   bun run scripts/backfill-qr-codes.ts
 */

import { $ } from "bun";
import { readdir, readFile } from "fs/promises";
import { BOOK_QR_PREFIX, BOOK_QR_CODE_LENGTH, BOOK_QR_CHARSET } from "../shared/qr";

const CODE_REGEX = new RegExp(
  `${BOOK_QR_PREFIX}[${BOOK_QR_CHARSET}]{${BOOK_QR_CODE_LENGTH}}`,
  "g",
);

async function loadAllPrintedCodes(): Promise<Set<string>> {
  const dir = "qr-codes";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".txt"));
  if (files.length === 0) {
    throw new Error(
      `No .txt files found in ${dir}/ - expected codes-batch-*.txt`,
    );
  }

  const codes = new Set<string>();
  for (const file of files) {
    const content = await readFile(`${dir}/${file}`, "utf-8");
    for (const match of content.matchAll(CODE_REGEX)) {
      codes.add(match[0]);
    }
  }
  return codes;
}

async function loadLinkedCodes(): Promise<Set<string>> {
  const result =
    await $`bunx wrangler d1 execute community-library-db --local --json --command="SELECT qr_code_id FROM book_copies"`.text();

  const jsonStart = result.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`Unexpected wrangler output (no JSON found):\n${result}`);
  }
  const parsed = JSON.parse(result.slice(jsonStart)) as Array<{
    results: Array<{ qr_code_id: string }>;
  }>;
  const rows = parsed[0]?.results ?? [];
  return new Set(rows.map((r) => r.qr_code_id));
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

async function main() {
  const printedCodes = await loadAllPrintedCodes();
  const linkedCodes = await loadLinkedCodes();

  console.log(`Found ${printedCodes.size} pre-printed codes across batches.`);
  console.log(`Found ${linkedCodes.size} codes already linked to a book copy.`);

  const unknownLinked = [...linkedCodes].filter((c) => !printedCodes.has(c));
  if (unknownLinked.length > 0) {
    console.warn(
      `Warning: ${unknownLinked.length} linked code(s) don't appear in any codes-batch-*.txt file (e.g. ${unknownLinked[0]}). Adding them to the pool as unavailable too.`,
    );
    for (const code of unknownLinked) printedCodes.add(code);
  }

  const values = [...printedCodes]
    .sort()
    .map((code) => {
      const available = linkedCodes.has(code) ? 0 : 1;
      return `('${escapeSqlString(code)}', ${available}, ${Date.now()})`;
    })
    .join(",\n  ");

  const sql = `INSERT INTO qr_codes (code, available, created_at) VALUES\n  ${values}\nON CONFLICT(code) DO NOTHING;`;

  await Bun.write("/tmp/backfill-qr-codes.sql", sql);
  await $`bunx wrangler d1 execute community-library-db --local --file=/tmp/backfill-qr-codes.sql`;

  console.log(
    `Backfilled qr_codes: ${printedCodes.size - linkedCodes.size} available, ${linkedCodes.size} unavailable.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
