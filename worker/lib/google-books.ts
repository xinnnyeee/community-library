/**
 * Google Books API lookup, used by the "add new book" admin flow.
 * Given an ISBN, returns title / author / description for review before saving.
 */

export interface GoogleBooksResult {
  title: string;
  author: string;
  description: string;
}

/**
 * `ok: true, data: null` means Google Books was reachable and genuinely has no
 * record for this ISBN. `ok: false` means the lookup itself failed (network
 * error, rate limit, bad response) - these should NOT be presented to the user
 * as "this book doesn't exist", since it might just mean "try again".
 */
export type GoogleBooksLookup =
  | { ok: true; data: GoogleBooksResult | null }
  | { ok: false; error: string };

interface GoogleBooksVolume {
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    description?: string;
  };
}

interface GoogleBooksResponse {
  totalItems: number;
  items?: GoogleBooksVolume[];
}

export async function lookupGoogleBooks(
  isbn: string,
  apiKey?: string,
): Promise<GoogleBooksLookup> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}${
    apiKey ? `&key=${encodeURIComponent(apiKey)}` : ""
  }`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Google Books fetch failed for ISBN ${isbn}: ${message}`);
    return { ok: false, error: `Network error reaching Google Books: ${message}` };
  }

  if (!res.ok) {
    // Google Books' unauthenticated tier rate-limits fairly aggressively -
    // a 403/429 here is very often that, not "book doesn't exist".
    const body = await res.text().catch(() => "");
    console.error(
      `Google Books returned ${res.status} for ISBN ${isbn}: ${body.slice(0, 300)}`,
    );
    return {
      ok: false,
      error: `Google Books returned HTTP ${res.status}${
        res.status === 403 || res.status === 429
          ? " (likely rate-limited - wait a bit and try again)"
          : ""
      }`,
    };
  }

  const data = (await res.json()) as GoogleBooksResponse;
  const info = data.items?.[0]?.volumeInfo;
  if (!info) {
    return { ok: true, data: null };
  }

  const title = info.subtitle
    ? `${info.title ?? ""}: ${info.subtitle}`
    : (info.title ?? "");

  return {
    ok: true,
    data: {
      title,
      author: info.authors?.join(", ") ?? "Unknown Author",
      description: info.description ?? "No description available",
    },
  };
}
