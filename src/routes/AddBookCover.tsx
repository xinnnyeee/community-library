import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { resizeImageToWebp } from "@/lib/cover-image";
import { client } from "@/lib/api-client";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";

/**
 * Mobile-oriented page opened by scanning the QR code shown on the laptop's
 * /admin/add-book page after saving a book. Lets you snap the cover photo
 * with your phone's camera and upload it straight to that one book.
 */
export default function AddBookCover() {
  const { isbn } = useParams<{ isbn: string }>();

  const [status, setStatus] = useState<"loading" | "ready" | "not-found">(
    "loading",
  );
  const [bookTitle, setBookTitle] = useState("");
  const [hadExistingCover, setHadExistingCover] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!isbn) return;
    client.api.admin.books[":isbn"]
      .$get({ param: { isbn } })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || "error" in data) {
          setStatus("not-found");
          return;
        }
        setBookTitle(data.book.title);
        setHadExistingCover(!!data.book.imageUrl);
        setStatus("ready");
      })
      .catch(() => setStatus("not-found"));
  }, [isbn]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function handleUpload() {
    if (!file || !isbn) return;
    setUploading(true);
    try {
      const webpBlob = await resizeImageToWebp(file);
      const coverFile = new File([webpBlob], `${isbn}.webp`, {
        type: "image/webp",
      });

      const res = await client.api.admin.books[":isbn"].cover.$post({
        param: { isbn },
        form: { cover: coverFile },
      });
      const data = await res.json();

      if (!res.ok || "error" in data) {
        toast.error("error" in data ? data.error : "Upload failed");
        return;
      }

      setDone(true);
    } catch {
      toast.error("Couldn't reach the server - check you're on the same Wi-Fi");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm p-6">
      <Toaster />
      <h1 className="mb-4 text-lg font-semibold">Add Cover Photo</h1>

      {status === "loading" && (
        <p className="text-muted-foreground text-sm">Loading...</p>
      )}

      {status === "not-found" && (
        <p className="text-destructive text-sm">
          No book found for ISBN {isbn}. Save it from the laptop first, then
          scan its QR code again.
        </p>
      )}

      {status === "ready" && !done && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{bookTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {hadExistingCover && (
              <p className="text-sm text-amber-600">
                This book already has a cover - uploading a new one will
                replace it.
              </p>
            )}
            <Input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {previewUrl && (
              <img
                src={previewUrl}
                alt="Cover preview"
                className="h-48 w-full rounded border object-contain"
              />
            )}
            <Button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="w-full"
            >
              {uploading ? "Uploading..." : "Upload cover"}
            </Button>
          </CardContent>
        </Card>
      )}

      {done && (
        <p className="text-sm">
          Cover uploaded for <strong>{bookTitle}</strong>. You can close this
          tab, or scan another book's QR code to add its cover.
        </p>
      )}
    </div>
  );
}
