/**
 * Pushes a cover image (already-encoded webp bytes) into the covers GitHub repo
 * via the Contents API, and returns the resulting jsDelivr CDN URL.
 *
 * jsDelivr's GitHub CDN serves whatever is committed to a public GitHub repo at
 * https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path} - there is no separate
 * "upload to jsDelivr" step, we just commit the file to the repo directly.
 */

export interface UploadCoverParams {
  token: string;
  /** "owner/repo", e.g. "xinnnyeee/community-library-images" */
  repo: string;
  isbn: string;
  webpBytes: Uint8Array;
  branch?: string;
}

export interface UploadCoverResult {
  cdnUrl: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function uploadCoverToGithub(
  params: UploadCoverParams,
): Promise<UploadCoverResult> {
  const { token, repo, isbn, webpBytes, branch = "main" } = params;
  const path = `assets/covers/${isbn}.webp`;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "community-library-admin",
  };

  // If a cover already exists at this path (re-scanning the same ISBN), GitHub
  // requires the current file's sha to overwrite it.
  let sha: string | undefined;
  const existingRes = await fetch(`${apiUrl}?ref=${branch}`, { headers });
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as { sha: string };
    sha = existing.sha;
  }

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Add cover for ISBN ${isbn}`,
      content: bytesToBase64(webpBytes),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub cover upload failed (${putRes.status}): ${errText}`);
  }

  return {
    cdnUrl: `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
  };
}
