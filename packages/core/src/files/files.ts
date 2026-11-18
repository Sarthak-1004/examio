import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { files, withContext, withWorkerContext, type Db, type RequestContext } from "@examio/db";
import { audit } from "../audit";
import { requireSchoolScope, requireSignedIn, requireUuid } from "../authz";
import { withCapability } from "../capabilities";
import { AppError } from "../errors";
import { PermanentJobError, enqueueJob, type ClaimedJob } from "../jobs/queue";
import { enforceRateLimits } from "../rate-limit";
import type { FileScanner } from "./scanner";
import { newStorageKey, type FileStorage } from "./storage";
import { FILE_PURPOSES, detectType, extensionMatches, isUploadPurpose, sanitizeFileName, type DetectedType, type FilePurpose } from "./types";

/**
 * Private file storage.
 *
 * Upload: validate (purpose, size, type detected from the bytes, matching extension, safe
 * name) → store bytes under a random key → record the file as quarantined and queue a scan,
 * in one transaction. Download: only files the caller may see (database policy), only once
 * scanned clean, only before expiry, and only if the bytes still match their checksum.
 */
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface UploadInput {
  schoolId: string;
  purpose: string;
  fileName: string;
  data: Buffer;
}

export async function uploadFile(
  db: Db,
  ctx: RequestContext,
  storage: FileStorage,
  input: UploadInput,
): Promise<{ id: string; status: "quarantined"; contentType: DetectedType }> {
  requireSignedIn(ctx);
  if (!isUploadPurpose(input.purpose)) throw new AppError("VALIDATION", "Unknown upload purpose.");
  const rules = FILE_PURPOSES[input.purpose];
  const fileName = sanitizeFileName(input.fileName);
  if (!fileName) throw new AppError("VALIDATION", "The file needs a name.", { file: "The file needs a name." });
  if (input.data.length === 0) throw new AppError("VALIDATION", "The file is empty.", { file: "The file is empty." });
  if (input.data.length > rules.maxBytes) {
    const mb = Math.round(rules.maxBytes / 1024 / 1024);
    throw new AppError("VALIDATION", `The file is larger than ${mb} MB.`, { file: `Larger than ${mb} MB.` });
  }
  const type = detectType(input.data, fileName);
  if (!type || !(rules.types as readonly string[]).includes(type) || !extensionMatches(type, fileName)) {
    throw new AppError("VALIDATION", "This type of file is not accepted, or its name does not match its contents.", { file: "File type not accepted." });
  }

  await enforceRateLimits(db, [{ scope: "upload:user", subject: ctx.userId, limit: 60, windowSeconds: 10 * 60 }]);

  // Checked before anything is stored: the capability check inside the transaction repeats it.
  requireUuid(input.schoolId, "School");
  requireSchoolScope(ctx, input.schoolId);
  const key = newStorageKey(input.schoolId);
  const checksum = sha256(input.data);
  // Bytes first, then the record: a failed transaction removes the bytes again. A crash in
  // between leaves an unreferenced blob, which is harmless and never downloadable.
  await storage.put(key, input.data);
  try {
    const capability: FilePurpose["capability"] = (rules as FilePurpose).capability ?? "school.files.upload";
    const id = await withCapability(db, ctx, input.schoolId, capability, async (tx, actor) => {
      const [row] = await tx
        .insert(files)
        .values({
          schoolId: input.schoolId,
          uploadedBy: actor.userId,
          purpose: input.purpose,
          originalName: fileName,
          contentType: type,
          sizeBytes: input.data.length,
          sha256: checksum,
          storageKey: key,
        })
        .returning({ id: files.id });
      if (!row) throw new Error("file record was not created");
      await enqueueJob(tx, { kind: "file.scan", payload: { fileId: row.id }, dedupeKey: row.id, schoolId: input.schoolId, maxAttempts: 10 });
      await audit(tx, {
        action: "file.uploaded",
        actorUserId: actor.userId,
        schoolId: input.schoolId,
        entityType: "file",
        entityId: row.id,
        data: { purpose: input.purpose, contentType: type, sizeBytes: input.data.length },
      });
      return row.id;
    });
    return { id, status: "quarantined", contentType: type };
  } catch (e) {
    await storage.delete(key).catch(() => undefined);
    throw e;
  }
}

export interface FileInfo {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: "quarantined" | "clean" | "rejected" | "deleted";
  createdAt: Date;
  expiresAt: Date | null;
}

const infoColumns = {
  id: files.id,
  originalName: files.originalName,
  contentType: files.contentType,
  sizeBytes: files.sizeBytes,
  status: files.status,
  createdAt: files.createdAt,
  expiresAt: files.expiresAt,
};

/** Metadata of one file the caller may see. Another school's file is "not found". */
export async function getFileInfo(db: Db, ctx: RequestContext, fileId: string): Promise<FileInfo> {
  requireSignedIn(ctx);
  requireUuid(fileId, "File");
  const [row] = await withContext(db, ctx, (tx) => tx.select(infoColumns).from(files).where(eq(files.id, fileId)));
  if (!row) throw new AppError("NOT_FOUND", "File not found.");
  return row;
}

/**
 * The bytes of a file the caller may download. Quarantined and rejected files are refused,
 * expired exports are "not found", and a checksum mismatch is treated as an incident.
 */
export async function downloadFile(
  db: Db,
  ctx: RequestContext,
  storage: FileStorage,
  fileId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  requireSignedIn(ctx);
  requireUuid(fileId, "File");
  const row = await withContext(db, ctx, async (tx) => {
    const [f] = await tx
      .select({ ...infoColumns, schoolId: files.schoolId, storageKey: files.storageKey, sha256: files.sha256 })
      .from(files)
      .where(eq(files.id, fileId));
    if (!f) return null;
    if (f.status === "clean" && !(f.expiresAt && f.expiresAt.getTime() <= Date.now())) {
      await audit(tx, { action: "file.downloaded", actorUserId: ctx.userId, schoolId: f.schoolId, entityType: "file", entityId: f.id });
    }
    return f;
  });
  if (!row || row.status === "deleted" || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
    throw new AppError("NOT_FOUND", "File not found.");
  }
  if (row.status === "quarantined") throw new AppError("CONFLICT", "This file is still being checked. Try again in a few minutes.");
  if (row.status !== "clean") throw new AppError("CONFLICT", "This file was blocked by the security check and cannot be downloaded.");
  const data = await storage.get(row.storageKey);
  if (sha256(data) !== row.sha256) throw new Error(`Stored file ${row.id} does not match its checksum`);
  return { fileName: row.originalName, contentType: row.contentType, data };
}

/** Mark a file deleted (uploader or school admin). Its bytes are removed by the worker. */
export async function deleteFile(db: Db, ctx: RequestContext, fileId: string): Promise<void> {
  requireSignedIn(ctx);
  requireUuid(fileId, "File");
  await withContext(db, ctx, async (tx) => {
    const marked = await tx
      .update(files)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(and(eq(files.id, fileId), sql`${files.status} <> 'deleted'`))
      .returning({ schoolId: files.schoolId });
    const f = marked[0];
    if (!f) throw new AppError("NOT_FOUND", "File not found.");
    await audit(tx, { action: "file.deleted", actorUserId: ctx.userId, schoolId: f.schoolId, entityType: "file", entityId: fileId });
  });
}

/**
 * Stores a file the system generated for one person (an export). Runs as the worker. The file
 * is downloadable by that person (and the school's admins) until it expires, at most 7 days.
 */
export async function storeExport(
  db: Db,
  storage: FileStorage,
  input: { schoolId: string; ownerUserId: string; fileName: string; contentType: "text/csv" | "application/pdf" | "text/plain"; data: Buffer; ttlSeconds: number },
): Promise<string> {
  const fileName = sanitizeFileName(input.fileName);
  if (!fileName) throw new Error("Export needs a file name");
  const key = newStorageKey(input.schoolId);
  await storage.put(key, input.data);
  try {
    const rows = (await withWorkerContext(db, input.schoolId, (tx) =>
      tx.execute<{ id: string } & Record<string, unknown>>(sql`select file_create_export(
        ${input.schoolId}::uuid, ${input.ownerUserId}::uuid, ${fileName}, ${input.contentType}, ${input.data.length}::bigint,
        ${sha256(input.data)}, ${key}, now() + make_interval(secs => ${input.ttlSeconds}::integer)
      ) as id`),
    )) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("export was not recorded");
    return id;
  } catch (e) {
    await storage.delete(key).catch(() => undefined);
    throw e;
  }
}

interface ScanRow extends Record<string, unknown> {
  id: string;
  storage_key: string;
  sha256: string;
  status: string;
}

/** Job handler for `file.scan`. Rejected files have their bytes removed at once. */
export function fileScanHandler(db: Db, storage: FileStorage, scanner: FileScanner) {
  return async (job: ClaimedJob): Promise<void> => {
    const fileId = job.payload.fileId;
    if (typeof fileId !== "string" || !/^[0-9a-f-]{36}$/i.test(fileId)) throw new PermanentJobError("payload has no valid fileId");
    const rows = (await withWorkerContext(db, job.schoolId, (tx) => tx.execute<ScanRow>(sql`select * from file_for_scan(${fileId}::uuid)`))) as unknown as ScanRow[];
    const f = rows[0];
    if (!f) throw new PermanentJobError("file no longer exists");
    if (f.status !== "quarantined") return; // already decided, or deleted meanwhile

    const data = await storage.get(f.storage_key);
    const result = sha256(data) !== f.sha256 ? { clean: false, detail: "stored bytes do not match the uploaded checksum" } : await scanner.scan(data);
    await withWorkerContext(db, job.schoolId, (tx) =>
      tx.execute(sql`select file_record_scan(${fileId}::uuid, ${result.clean ? "clean" : "rejected"}::file_status, ${result.detail})`),
    );
    if (!result.clean) {
      await storage.delete(f.storage_key);
      await withWorkerContext(db, job.schoolId, (tx) => tx.execute(sql`select file_mark_purged(${fileId}::uuid)`));
    }
  };
}

/** Removes stored bytes of rejected, deleted and expired files. Returns how many were purged. */
export async function purgeFiles(db: Db, storage: FileStorage, maxRows = 200): Promise<number> {
  const candidates = (await withWorkerContext(db, null, (tx) =>
    tx.execute<{ id: string; storage_key: string } & Record<string, unknown>>(sql`select * from file_purge_candidates(${maxRows}::integer)`),
  )) as unknown as { id: string; storage_key: string }[];
  for (const c of candidates) {
    await storage.delete(c.storage_key);
    await withWorkerContext(db, null, (tx) => tx.execute(sql`select file_mark_purged(${c.id}::uuid)`));
  }
  return candidates.length;
}
