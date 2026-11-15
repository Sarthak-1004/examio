import "server-only";
import { AppError, uploadFile, type UploadPurpose } from "@examio/core";
import type { RequestContext } from "@examio/db";
import { db } from "./db";
import { fileStorage } from "./runtime";

/**
 * Uploads the files chosen in a form field ("files") with one purpose and returns their ids.
 * Not a server action: callers pass the context of their own authenticated session.
 */
export async function uploadChosenFiles(ctx: RequestContext, schoolId: string, fd: FormData, purpose: UploadPurpose, max = 5): Promise<string[]> {
  const chosen = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (chosen.length > max) throw new AppError("VALIDATION", `Attach at most ${max} files at a time.`, { files: "Too many files." });
  const ids: string[] = [];
  for (const f of chosen) {
    const up = await uploadFile(db, ctx, fileStorage(), { schoolId, purpose, fileName: f.name, data: Buffer.from(await f.arrayBuffer()) });
    ids.push(up.id);
  }
  return ids;
}
