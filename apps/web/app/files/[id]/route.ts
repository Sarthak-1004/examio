import { AppError, contentDisposition, downloadFile } from "@examio/core";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { fileStorage } from "@/lib/runtime";

/**
 * Authorized file download. The service checks who may see the file, that it was scanned
 * clean, has not expired and still matches its checksum. The response always downloads
 * (never renders in the page), is never cached, and cannot run scripts if opened directly.
 */
const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getSession();
  if (!session || session.user.mustChangePassword) return plain(401, "Sign in to download this file.");
  const { id } = await ctx.params;
  try {
    const file = await downloadFile(db, session.ctx, fileStorage(), id);
    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "content-type": file.contentType.startsWith("text/") ? `${file.contentType}; charset=utf-8` : file.contentType,
        "content-length": String(file.data.length),
        "content-disposition": contentDisposition(file.fileName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (e) {
    if (e instanceof AppError && e.code === "NOT_FOUND") return plain(404, "File not found.");
    if (e instanceof AppError && e.code === "CONFLICT") return plain(409, e.message);
    throw e;
  }
}
