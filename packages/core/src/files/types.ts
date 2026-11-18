import path from "node:path";

/**
 * File types and upload rules. The type is detected from the file's bytes; the name's
 * extension must agree with it. What the browser claims (Content-Type) is ignored.
 */
export type DetectedType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "text/csv" | "text/plain";

const EXTENSIONS: Record<DetectedType, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "text/csv": [".csv"],
  "text/plain": [".txt"],
};

const startsWith = (data: Buffer, bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);

/** Detects the type from magic bytes, or null when it is not an accepted type. */
export function detectType(data: Buffer, fileName: string): DetectedType | null {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // Text: valid UTF-8, no NUL bytes. CSV versus plain text follows the extension.
  if (!data.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return path.extname(fileName).toLowerCase() === ".csv" ? "text/csv" : "text/plain";
    } catch {
      return null;
    }
  }
  return null;
}

export interface FilePurpose {
  /** Largest accepted size in bytes. */
  maxBytes: number;
  types: readonly DetectedType[];
  /** Capability needed to upload; default `school.files.upload`. */
  capability?: "school.files.upload" | "school.homework.submit" | "school.admissions.manage";
}

/**
 * Upload purposes. Modules add their own (homework attachments, profile documents, …) with
 * their size and type limits; `export` is reserved for files the system generates.
 */
export const FILE_PURPOSES = {
  general: { maxBytes: 10 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/csv", "text/plain"] },
  /** Documents on a student's record (Phase 5); visible to the school's administrators. */
  student_document: { maxBytes: 10 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg", "image/webp"] },
  /** Attachments to homework (Phase 7); readable by everyone who can read the homework. */
  homework_attachment: { maxBytes: 10 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"] },
  /** An image in a question (Phase 9); readable by those who can read the question. */
  question_image: { maxBytes: 2 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp"] },
  /** A student's files for a submission (Phase 7); readable by the student, their parents and reviewing staff. */
  /** A document on an admission application (Phase 13.1); visible to the school's administrators. */
  admission_document: { maxBytes: 10 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg", "image/webp"], capability: "school.admissions.manage" },
  homework_submission: { maxBytes: 10 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"], capability: "school.homework.submit" },
} as const satisfies Record<string, FilePurpose>;

export type UploadPurpose = keyof typeof FILE_PURPOSES;

export function isUploadPurpose(value: string): value is UploadPurpose {
  return Object.prototype.hasOwnProperty.call(FILE_PURPOSES, value);
}

export function extensionMatches(type: DetectedType, fileName: string): boolean {
  return EXTENSIONS[type].includes(path.extname(fileName).toLowerCase());
}

/**
 * Makes an uploaded name safe to store and to offer back as a download name: no folders, no
 * control or reserved characters, no leading dots, at most 200 characters with the extension
 * kept. Returns null when nothing usable is left.
 */
export function sanitizeFileName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (cleaned === "" || /^\.*$/.test(cleaned)) return null;
  if (cleaned.length <= 200) return cleaned;
  const ext = path.extname(cleaned).slice(0, 10);
  return cleaned.slice(0, 200 - ext.length) + ext;
}

/** `Content-Disposition` value that forces a download with a safe, UTF-8 file name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
