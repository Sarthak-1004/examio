import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditEvents, files, jobs, schoolMemberships, withContext, type RequestContext } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { deleteFile, downloadFile, getFileInfo, purgeFiles, storeExport, uploadFile } from "../src/files/files";
import { clamavScanner, devAllowScanner, fileScannerFromEnv, type FileScanner } from "../src/files/scanner";
import { localDiskStorage, newStorageKey } from "../src/files/storage";
import { contentDisposition, detectType, sanitizeFileName } from "../src/files/types";
import { runWorkerOnce } from "../src/jobs/queue";
import { createLogger } from "../src/logger";
import { sandboxEmailAdapter } from "../src/notifications/email";
import { startSupportAccess, endSupportAccess } from "../src/services/support-access";
import { createJobHandlers } from "../src/worker";
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 2, task 02.3: private file storage with validation, quarantine, scanning and authorized downloads. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const quiet = createLogger({}, { write: () => {} });
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "examio-files-test-"));
const storage = localDiskStorage(storageDir);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const storedFiles = () => fs.readdirSync(storageDir, { recursive: true }).filter((p) => !String(p).endsWith(".tmp") && fs.statSync(path.join(storageDir, String(p))).isFile());

describe("private files", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;
  let otherTeacher: string;

  const work = (scanner: FileScanner | null) =>
    runWorkerOnce(app.db, {
      workerId: "files-test",
      handlers: createJobHandlers({ db: app.db, email: sandboxEmailAdapter(), log: quiet, storage, scanner }),
      log: quiet,
    });
  const upload = (ctx: RequestContext, data: Buffer = PDF, fileName = "report.pdf", schoolId = ctx.schoolId!) =>
    uploadFile(app.db, ctx, storage, { schoolId, purpose: "general", fileName, data });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("fla");
    B = await makeSchool("flb");
    platform = { userId: await makeUser({ isPlatformAdmin: true }), schoolId: null, isPlatformAdmin: true };
    otherTeacher = await makeUser();
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: otherTeacher, role: "teacher" });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("an upload is quarantined until scanned clean, then downloadable by the uploader", async () => {
    const { id, status, contentType } = await upload(A.ctx(A.teacherId));
    expect({ status, contentType }).toEqual({ status: "quarantined", contentType: "application/pdf" });
    expect(await outcome(downloadFile(app.db, A.ctx(A.teacherId), storage, id))).toBe("CONFLICT");

    const [scanJob] = await owner.db.select().from(jobs).where(eq(jobs.dedupeKey, id));
    expect(scanJob).toMatchObject({ kind: "file.scan", schoolId: A.id, payload: { fileId: id } });

    expect(await work(devAllowScanner())).toMatchObject({ succeeded: 1 });
    const got = await downloadFile(app.db, A.ctx(A.teacherId), storage, id);
    expect(got).toMatchObject({ fileName: "report.pdf", contentType: "application/pdf" });
    expect(got.data.equals(PDF)).toBe(true);

    const events = await owner.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(events.map((e) => e.action).sort()).toEqual(["file.downloaded", "file.scan_clean", "file.uploaded"]);
  });

  it("an infected upload is rejected and its bytes removed", async () => {
    const infected: FileScanner = { name: "fake", scan: async () => ({ clean: false, detail: "Eicar-Test-Signature FOUND" }) };
    const { id } = await upload(A.ctx(A.teacherId), EICAR, "notes.txt");
    const before = storedFiles().length;
    expect(await work(infected)).toMatchObject({ succeeded: 1 });
    const [row] = await owner.db.select().from(files).where(eq(files.id, id));
    expect(row).toMatchObject({ status: "rejected", scanResult: "Eicar-Test-Signature FOUND" });
    expect(row!.purgedAt).not.toBeNull();
    expect(storedFiles().length).toBe(before - 1);
    expect(await outcome(downloadFile(app.db, A.ctx(A.teacherId), storage, id))).toBe("CONFLICT");
  });

  it("a scanner outage retries the scan later; without a scanner files simply stay quarantined", async () => {
    const { id } = await upload(A.ctx(A.adminId));
    const down: FileScanner = { name: "down", scan: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3310"); } };
    expect(await work(down)).toMatchObject({ retried: 1 });
    expect((await getFileInfo(app.db, A.ctx(A.adminId), id)).status).toBe("quarantined");
    await owner.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.dedupeKey, id));

    expect((await work(null)).claimed).toBe(0);
    expect((await getFileInfo(app.db, A.ctx(A.adminId), id)).status).toBe("quarantined");
    expect(await work(devAllowScanner())).toMatchObject({ succeeded: 1 });
    expect((await getFileInfo(app.db, A.ctx(A.adminId), id)).status).toBe("clean");
  });

  it("validates size, type, extension and name", async () => {
    const ctx = A.ctx(A.teacherId);
    expect(await outcome(upload(ctx, Buffer.alloc(0), "empty.pdf"))).toBe("VALIDATION");
    expect(await outcome(upload(ctx, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), "huge.pdf"))).toBe("VALIDATION");
    expect(await outcome(upload(ctx, PNG, "image.pdf"))).toBe("VALIDATION"); // name does not match contents
    expect(await outcome(upload(ctx, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "setup.exe"))).toBe("VALIDATION");
    expect(await outcome(upload(ctx, Buffer.from("plain text"), "script.html"))).toBe("VALIDATION");
    expect(await outcome(upload(ctx, PDF, "..."))).toBe("VALIDATION");
    expect(await outcome(uploadFile(app.db, ctx, storage, { schoolId: A.id, purpose: "export", fileName: "x.pdf", data: PDF }))).toBe("VALIDATION");

    const { id } = await upload(ctx, PNG, "../../etc/<photo>.png");
    expect((await getFileInfo(app.db, ctx, id)).originalName).toBe("photo.png");
  });

  it("only the uploader, the school's admins and granted platform support can see a file", async () => {
    const { id } = await upload(A.ctx(A.teacherId));
    await work(devAllowScanner());

    expect(await outcome(downloadFile(app.db, A.ctx(A.adminId), storage, id))).toBe("OK");
    for (const ctx of [A.ctx(otherTeacher), A.ctx(A.studentId), B.ctx(B.adminId), { ...B.ctx(B.adminId), schoolId: A.id }, platform]) {
      expect(await outcome(downloadFile(app.db, ctx, storage, id))).toBe("NOT_FOUND");
      expect(await outcome(getFileInfo(app.db, ctx, id))).toBe("NOT_FOUND");
    }
    const grant = await startSupportAccess(app.db, platform, { schoolId: A.id, reason: "Ticket 9: file will not open" });
    expect(await outcome(downloadFile(app.db, platform, storage, id))).toBe("OK");
    await endSupportAccess(app.db, platform, grant.id);
    expect(await outcome(downloadFile(app.db, platform, storage, id))).toBe("NOT_FOUND");

    // A teacher who leaves the school loses access to their own uploads.
    await owner.db.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, A.teacherId));
    expect(await outcome(downloadFile(app.db, A.ctx(A.teacherId), storage, id))).toBe("NOT_FOUND");
    await owner.db.update(schoolMemberships).set({ status: "active" }).where(eq(schoolMemberships.userId, A.teacherId));
  });

  it("students cannot upload, and nobody can upload into another school", async () => {
    expect(await outcome(upload(A.ctx(A.studentId)))).toBe("FORBIDDEN");
    expect(await outcome(upload(A.ctx(A.adminId), PDF, "x.pdf", B.id))).toBe("NOT_FOUND");
    const before = storedFiles().length;
    expect(await outcome(upload(A.ctx(A.studentId)))).toBe("FORBIDDEN");
    expect(storedFiles().length).toBe(before); // the refused upload left no bytes behind
  });

  it("the database refuses forged scan results and cross-school records", async () => {
    const { id } = await upload(A.ctx(A.teacherId));
    const tx = (ctx: RequestContext, run: Parameters<typeof withContext>[2]) => withContext(app.db, ctx, run).then(() => null, (e: unknown) => e);
    const values = { schoolId: A.id, uploadedBy: A.teacherId, purpose: "general", originalName: "a.pdf", contentType: "application/pdf", sizeBytes: 10, sha256: "a".repeat(64), storageKey: newStorageKey(A.id) };
    expect(isRlsViolation(await tx(A.ctx(A.teacherId), (t) => t.insert(files).values({ ...values, status: "clean" })))).toBe(true);
    expect(isRlsViolation(await tx(A.ctx(A.teacherId), (t) => t.insert(files).values({ ...values, schoolId: B.id, storageKey: newStorageKey(B.id) })))).toBe(true);
    expect(isRlsViolation(await tx(A.ctx(A.teacherId), (t) => t.insert(files).values({ ...values, uploadedBy: A.adminId })))).toBe(true);
    expect(isRlsViolation(await tx(A.ctx(A.adminId), (t) => t.update(files).set({ status: "clean" }).where(eq(files.id, id))))).toBe(true);
    expect(isRlsViolation(await tx(A.ctx(A.adminId), (t) => t.update(files).set({ storageKey: newStorageKey(A.id) }).where(eq(files.id, id))))).toBe(true);
    expect(isRlsViolation(await tx(A.ctx(A.adminId), (t) => t.delete(files).where(eq(files.id, id))))).toBe(true);
    const scan = await tx(A.ctx(A.adminId), (t) => t.execute(sql`select file_record_scan(${id}::uuid, 'clean', 'forged')`));
    expect(isRlsViolation(scan)).toBe(true);
    expect((await getFileInfo(app.db, A.ctx(A.adminId), id)).status).toBe("quarantined");
  });

  it("a deleted file is gone for everyone and its bytes are purged", async () => {
    const { id } = await upload(A.ctx(A.teacherId));
    await work(devAllowScanner());
    expect(await outcome(deleteFile(app.db, A.ctx(otherTeacher), id))).toBe("NOT_FOUND");
    await deleteFile(app.db, A.ctx(A.teacherId), id);
    expect(await outcome(downloadFile(app.db, A.ctx(A.adminId), storage, id))).toBe("NOT_FOUND");
    expect(await outcome(deleteFile(app.db, A.ctx(A.teacherId), id))).toBe("NOT_FOUND");
    const [row] = await owner.db.select().from(files).where(eq(files.id, id));
    expect(await purgeFiles(app.db, storage)).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(storageDir, ...row!.storageKey.split("/")))).toBe(false);
  });

  it("exports are downloadable by their owner until they expire, then purged", async () => {
    const id = await storeExport(app.db, storage, { schoolId: A.id, ownerUserId: A.teacherId, fileName: "attendance.csv", contentType: "text/csv", data: Buffer.from("a,b\n1,2\n"), ttlSeconds: 3600 });
    expect((await downloadFile(app.db, A.ctx(A.teacherId), storage, id)).data.toString()).toBe("a,b\n1,2\n");
    expect(await outcome(downloadFile(app.db, A.ctx(otherTeacher), storage, id))).toBe("NOT_FOUND");

    await owner.db.update(files).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(files.id, id));
    expect(await outcome(downloadFile(app.db, A.ctx(A.teacherId), storage, id))).toBe("NOT_FOUND");
    await purgeFiles(app.db, storage);
    const [row] = await owner.db.select().from(files).where(eq(files.id, id));
    expect(row!.purgedAt).not.toBeNull();

    const tooLong = storeExport(app.db, storage, { schoolId: A.id, ownerUserId: A.teacherId, fileName: "x.csv", contentType: "text/csv", data: Buffer.from("x"), ttlSeconds: 8 * 86400 });
    expect(await outcome(tooLong)).not.toBe("OK");
  });

  it("refuses to serve bytes that no longer match their checksum", async () => {
    const { id } = await upload(A.ctx(A.adminId), Buffer.from("hello"), "hello.txt");
    await work(devAllowScanner());
    const [row] = await owner.db.select().from(files).where(eq(files.id, id));
    fs.writeFileSync(path.join(storageDir, ...row!.storageKey.split("/")), "tampered");
    await expect(downloadFile(app.db, A.ctx(A.adminId), storage, id)).rejects.toThrow(/checksum/);
  });

  it("storage keys cannot escape the storage folder", async () => {
    for (const key of ["../../etc/passwd", `${randomUUID()}/../../x`, "a/b", ""]) {
      await expect(storage.get(key)).rejects.toThrow(/Invalid storage key/);
    }
  });
});

describe("file type rules", () => {
  it("detects types from bytes and sanitizes names", () => {
    expect(detectType(PDF, "a.pdf")).toBe("application/pdf");
    expect(detectType(PNG, "a.png")).toBe("image/png");
    expect(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "a.jpg")).toBe("image/jpeg");
    expect(detectType(Buffer.from("a,b\n"), "a.csv")).toBe("text/csv");
    expect(detectType(Buffer.from([0xc3, 0x28]), "bad.txt")).toBeNull(); // invalid UTF-8
    expect(detectType(Buffer.from([0x00, 0x01]), "a.txt")).toBeNull();
    expect(sanitizeFileName("C:\\Users\\me\\..\\report\u0000.pdf")).toBe("report.pdf");
    expect(sanitizeFileName(".hidden")).toBe("hidden");
    expect(sanitizeFileName(`${"n".repeat(300)}.pdf`)).toMatch(/^n{196}\.pdf$/);
    const name = 'मराठी "x".pdf';
    const ascii = `${"_".repeat([..."मराठी"].length)} _x_.pdf`;
    expect(contentDisposition(name)).toBe(`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it("chooses scanners from configuration and refuses dev-allow in production", () => {
    expect(fileScannerFromEnv({})).toBeNull();
    expect(fileScannerFromEnv({ FILE_SCANNER: "dev-allow" })?.name).toBe("dev-allow");
    expect(() => fileScannerFromEnv({ FILE_SCANNER: "dev-allow", EXAMIO_ENV: "production" })).toThrow(/not allowed in staging or production/);
    expect(() => fileScannerFromEnv({ FILE_SCANNER: "dev-allow", EXAMIO_ENV: "staging" })).toThrow(/not allowed in staging or production/);
    // `next start` sets NODE_ENV=production on developer machines too; that alone does not count.
    expect(fileScannerFromEnv({ FILE_SCANNER: "dev-allow", NODE_ENV: "production" })?.name).toBe("dev-allow");
    expect(fileScannerFromEnv({ FILE_SCANNER: "clamav", CLAMAV_PORT: "3310" })?.name).toBe("clamav");
    expect(() => fileScannerFromEnv({ FILE_SCANNER: "clamav", CLAMAV_PORT: "99999" })).toThrow(/CLAMAV_PORT/);
    expect(() => fileScannerFromEnv({ FILE_SCANNER: "virustotal" })).toThrow(/not supported/);
  });

  it("speaks the ClamAV INSTREAM protocol", async () => {
    // A stand-in clamd: reads length-prefixed chunks until the zero terminator.
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const header = Buffer.from("zINSTREAM\0");
        if (buf.length < header.length) return;
        let offset = header.length;
        const body: Buffer[] = [];
        while (offset + 4 <= buf.length) {
          const len = buf.readUInt32BE(offset);
          if (len === 0) {
            const content = Buffer.concat(body).toString("latin1");
            socket.end(content.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
            return;
          }
          if (offset + 4 + len > buf.length) return;
          body.push(buf.subarray(offset + 4, offset + 4 + len));
          offset += 4 + len;
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const scanner = clamavScanner("127.0.0.1", port, 5000);
      expect(await scanner.scan(Buffer.concat([Buffer.alloc(200_000, 7), PDF]))).toEqual({ clean: true, detail: "clamav: OK" });
      expect(await scanner.scan(EICAR)).toEqual({ clean: false, detail: "clamav: Eicar-Test-Signature FOUND" });
    } finally {
      server.close();
    }
    await expect(clamavScanner("127.0.0.1", port, 2000).scan(PDF)).rejects.toThrow();
  });
});
