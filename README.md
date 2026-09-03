# Community Library

A community-driven library for students and staff at NUSC. Members browse, borrow and return physical books via a Telegram bot / mini app; admins add books, print QR stickers for physical copies, and manage the catalog through a few local-only web pages.

**Stack:** React + Vite + Tailwind + shadcn/ui on the frontend, [Hono](https://hono.dev) on Cloudflare Workers for the backend, Cloudflare D1 (SQLite) via [Drizzle ORM](https://orm.drizzle.team) for the database, and [grammY](https://grammy.dev) for the Telegram bot.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh)
- A Cloudflare account (Wrangler is installed as a project dependency, run via `bunx wrangler`)

### 1. Install dependencies

```shell
bun install
```

### 2. Configure environment variables

Create a `.dev.vars` file in the project root (already gitignored) with:

```shell
BOT_TOKEN=              # Telegram bot token, from @BotFather
BOT_INFO=                # Bot info JSON - see the grammY docs linked below
ADMIN_GROUP_ID=          # Telegram group chat ID used for admin auth on bot commands, e.g. "-100xxxxxxxxxx"
MINIAPP_URL=             # URL of the Telegram Mini App, e.g. "https://t.me/your_bot/library"
GITHUB_TOKEN=            # PAT with write access to your book-cover images repo
GITHUB_IMAGES_REPO=      # e.g. "your-username/community-library-images"
GOOGLE_BOOKS_API_KEY=    # Used by the admin "add book" ISBN lookup
```

`GITHUB_TOKEN` / `GITHUB_IMAGES_REPO` are only needed for cover uploads on `/admin/add-covers`; `GOOGLE_BOOKS_API_KEY` is only needed for the admin add-book ISBN lookup - everything else runs fine without them.

### 3. Set up the local database

```shell
bunx wrangler d1 migrations apply community-library-db --local
```

This creates the local SQLite database under `.wrangler/state` and applies every migration in `drizzle/`, including seeding the `locations` table. If you ever change `worker/db/schema.ts`, generate a new migration first with `bunx drizzle-kit generate` before applying it.

If you have pre-printed QR sticker batches (see `qr-codes/`), seed the sticker pool table too:

```shell
bun run backfill-qr-codes
```

For bulk-importing a batch of scanned books (rather than adding them one at a time via the admin page), see [`docs/QUICK_START.md`](docs/QUICK_START.md) and [`docs/DATA_PIPELINE.md`](docs/DATA_PIPELINE.md).

### 4. Run the dev server

```shell
bun run dev
```

The dev server binds to `0.0.0.0` (not just `localhost`), so it's reachable from other devices on the same Wi-Fi - handy for testing the Telegram mini app on a phone during development. If you're using a Cloudflare Tunnel for local Telegram bot development, set `DEV_HOST` in a `.env` file so Vite allows that host too.

Other useful scripts: `bun run test` (Vitest), `bun run lint` (ESLint), `bun run build` (typecheck + production build), `bun run deploy` (build + `wrangler deploy`).

## Telegram Bot Setup

1. Follow the [grammY Cloudflare Workers guide](https://grammy.dev/hosting/cloudflare-workers-nodejs).
2. Create a bot via [@BotFather](https://t.me/BotFather) and grab its token and bot info.
3. Add the bot token and bot info to `.dev.vars` (or set them as `wrangler secret put` values in production).
4. If you're using a Cloudflare Tunnel for local bot development, set `DEV_HOST` in a `.env` file so Vite accepts connections through the tunnel.

## Inspecting the Database with Drizzle Studio

1. `@libsql/client` is already a dev dependency.
2. In `drizzle.config.ts`, point `dbCredentials.url` at your local D1 SQLite file under `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/...` (the exact filename is generated per-machine - `ls` that folder to find it).
3. Run `bunx drizzle-kit studio`.

## Admin Usage

Three admin-only pages live at `/admin/add-book`, `/admin/manage-books` and `/admin/add-covers`. None is gated behind Telegram admin auth (unlike the bot/mini-app routes) - they're meant to be run locally by whoever is curating the catalog, via `bun run dev`.

### 1. Running the program

```shell
git clone <this repo>
cd community-library
bun install
# create .dev.vars with the variables listed under "Configure environment variables" above
bunx wrangler d1 migrations apply community-library-db --local
bun run dev
```

Then open `http://localhost:5173/admin/add-book`, `/admin/manage-books` or `/admin/add-covers` - all three run entirely on this one device, no phone or LAN access needed.

### 2. Admin pages

**`/admin/add-book` - Add New Book**

Scan (with a USB barcode scanner) or type an ISBN, hit Enter:

1. The app checks for an existing book with that ISBN (to avoid duplicates) and looks it up on Google Books.
2. Title, author and description come back pre-filled and editable; pick a category from the dropdown.
3. Saving inserts exactly one new row into `books` - it never touches any existing book, copy, loan or location.
4. Saving never asks for a cover - it saves the book and immediately resets the form, focused and ready for the next scan, so a stack of books can be scanned in back-to-back. Covers are added afterwards, one at a time or in bulk, from `/admin/add-covers`.

**`/admin/manage-books` - Manage Books**

Search by title/ISBN and filter by category or location; select rows to batch-set their category or remove them. Per book, you can:

- Edit its title, author, description and category.
- Add a physical copy: type/scan the QR code on the sticker you're placing on the book and pick a location. Rejected if that QR code is already tagged to another copy.
- Move a copy to a different location.
- Remove a copy (frees its QR sticker back to the pool) or remove the whole book (removes all of its copies first). Both are blocked while any affected copy has an active, unreturned loan.

Physical copies can also be linked the other way - via the Telegram mini app, by scanning a QR sticker while viewing a book - which is the main path once the library is up and running; `/admin/manage-books` is generally for corrections and bulk cleanup.

An "Add covers" button in the header links to `/admin/add-covers`.

**`/admin/add-covers` - Add Covers**

The landing page lists every book currently missing a cover, oldest-added first, as a grid of cards. This is the catch-up page for books that were saved without a cover photo (skipped entirely, or handed off to a phone that never got scanned) - it needs no phone, no QR code and no LAN access, since it runs entirely on whatever device already has `bun run dev` open.

Per book, one at a time:

- **Add** (no cover yet) or **Replace** (cover already set) opens the device's file picker (or camera, on mobile) for a single photo, resized and re-encoded to webp in the browser exactly like the other cover-upload paths, then uploaded to that one book.
- **Remove** clears that book's cover back to "no cover" (`image_url` set to `null`). The image file itself is left in the GitHub images repo, unreferenced but harmless - nothing is deleted remotely.

For adding many covers at once - e.g. after a batch scanning session with CamScanner, which turns a stack of covers into a single multi-page PDF:

1. Tick the checkbox on at least two coverless book cards (selection is disabled once a card already has a cover). This enables the **Batch upload (N)** button.
2. Click it and upload the PDF. Every page is rendered client-side (no server round-trip) and, by default, auto-aligned in order: the PDF's first page to the first selected book, the second page to the second, and so on - matching the assumption that you scan/name covers in the same sequence you scanned the books, so no filename-to-ISBN naming is needed.
3. If the page count doesn't match the book count, or a page just landed on the wrong book, drag pages between book rows (and an "unused pages" tray) to fix the pairing before confirming - nothing is uploaded until you click Confirm.
4. Confirming uploads each paired page through the same per-book cover endpoint, one at a time, with a progress bar; any individual failures are reported without blocking the rest.

### 3. Exporting the database

Both scripts read from the **local** D1 database only (`wrangler d1 execute --local`) and only ever write CSVs - they never modify the database:

```shell
bun run export-books-csv   # writes exports/books.csv
bun run export-all-csv     # writes exports/{books,book_copies,loans,locations,qr_codes}.csv
```

Run either after making changes via the admin pages (Cloudflare Workers can't write files to disk on their own, so the CSVs don't update themselves). Output lands in `exports/` at the project root, which is gitignored - it's a point-in-time snapshot for backup/analysis, not something to commit.

To export the **production** database instead, run the same `wrangler d1 execute` command with `--remote` in place of `--local` (see either script for the exact SQL per table), or query the table you need directly:

```shell
bunx wrangler d1 execute community-library-db --remote --command="SELECT * FROM books"
```

### 4. Database schema

**Tables**

| Table | Key columns | Notes |
| --- | --- | --- |
| `locations` | `id`, `name` | Seeded by the initial migration; rarely changes. |
| `books` | `id`, `isbn` (unique), `title`, `author`, `description`, `image_url`, `category`, `created_at` | One row per unique ISBN - metadata only, no copy-count or availability. |
| `book_copies` | `qr_code_id` (PK, e.g. `COPY-4EXG4A`), `book_id`, `location_id`, `copy_number`, `status` | One row per physical copy. `status` defaults to `"available"` at creation and isn't updated anywhere else in the codebase today - see the note below the table. |
| `loans` | `id`, `qr_code_id`, `telegram_user_id`, `telegram_username`, `borrowed_at`, `due_date`, `returned_at`, `last_reminder_sent` | One row per borrow. An active (unreturned) loan has `returned_at IS NULL`; a unique partial index on `(qr_code_id, returned_at)` where `returned_at IS NULL` stops the same copy being borrowed twice at once. |
| `qr_codes` | `code` (PK, e.g. `COPY-4EXG4A`), `available`, `created_at` | Pool of pre-printed physical stickers. `available = true` until the code is tagged to a copy, then flips to `false`; removing that copy flips it back to `true` so the sticker can be reused. |

A copy's real-time availability is derived from whether it has an active loan (`loans` with `returned_at IS NULL`), **not** from `book_copies.status`. The `status` column exists for a future lost/damaged flag but nothing in the current code ever changes it away from `"available"`.

**What each action changes**

| Action | `books` | `book_copies` | `qr_codes` | `loans` | Guard |
| --- | --- | --- | --- | --- | --- |
| Add a new book (`/admin/add-book`) | Inserts 1 row | - | - | - | Rejected if the ISBN already exists. |
| Upload/replace a cover (from `/admin/add-covers`, one at a time or in batch) | Updates `image_url` on that one row | - | - | - | - |
| Remove a cover (`/admin/add-covers` "Remove") | Sets `image_url` back to `null` on that one row | - | - | - | - |
| Edit book details (Manage Books) | Updates `title`/`author`/`description`/`category` | - | - | - | - |
| Batch-set category (Manage Books) | Updates `category` on the selected rows | - | - | - | - |
| Add / link a physical copy (Manage Books "+ Add copy", or scanning a QR sticker in the Telegram mini app) | - | Inserts 1 row, `status = "available"` | Upserts that code to `available = false` | - | Rejected if the QR code is already tagged to another copy. |
| Move a copy to a different location | - | Updates `location_id` on that copy | - | - | - |
| Remove a physical copy | - | Deletes that copy | Upserts that code back to `available = true` | Deletes every loan row for that copy | Blocked if the copy has an active loan. Historical loan records for that specific copy are lost with it. |
| Remove a book (single or batch) | Deletes the book row | Same as "remove a copy", for every copy of the book | Same as "remove a copy", for every copy | Same as "remove a copy", for every copy | Blocked entirely - nothing is deleted - if any of its copies has an active loan. |
| Borrow a book (Telegram bot / mini app) | - | - | - | Inserts 1 row, due 14 days out | Blocked if that copy already has an active loan (enforced by the unique partial index, so concurrent borrows can't both succeed). |
| Return a book (Telegram bot / mini app) | - | - | - | Updates `returned_at` on that active loan | Only the borrower's own active loan for that copy can be returned this way. |
| Backfill QR pool (`bun run backfill-qr-codes`) | - | - | Inserts codes from `qr-codes/*.txt` not already in the pool | - | Never overwrites an existing row. |
| CSV exports (`bun run export-*-csv`) | - | - | - | - | Read-only - writes only to `exports/*.csv`. |

## Further Reading

- [`docs/QUICK_START.md`](docs/QUICK_START.md) - step-by-step guide for bulk-processing a new batch of scanned books.
- [`docs/DATA_PIPELINE.md`](docs/DATA_PIPELINE.md) - how that batch pipeline works internally.
- [`docs/BOOK_PROCESSING_SPEC.md`](docs/BOOK_PROCESSING_SPEC.md) - spec for the cover-image ingestion pipeline (in the companion `community-library-images` repo).
- [`docs/BOT_SPEC.md`](docs/BOT_SPEC.md) - Telegram bot command/design spec.
- [`docs/SPEC.md`](docs/SPEC.md) - original architecture/design notes for the project.
