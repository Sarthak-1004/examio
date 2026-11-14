import net from "node:net";

/**
 * Malware scanning for uploads. A file stays quarantined (not downloadable) until a scanner
 * reports it clean. Drivers:
 * - `clamav`: a ClamAV daemon reached over TCP (CLAMAV_HOST, CLAMAV_PORT), INSTREAM protocol.
 * - `dev-allow`: marks every file clean WITHOUT scanning. Development and tests only; refused
 *   when EXAMIO_ENV is staging or production. (NODE_ENV is not used: `next start` always sets
 *   it to production, including on a developer's machine.)
 * - unset / `none`: no scanner. Uploads stay quarantined, which is safe but means no file can
 *   be downloaded until one is configured.
 */
export interface ScanResult {
  clean: boolean;
  /** Signature name when infected, or a short note. */
  detail: string;
}

export interface FileScanner {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

export function devAllowScanner(): FileScanner {
  return { name: "dev-allow", scan: async () => ({ clean: true, detail: "not scanned (dev-allow)" }) };
}

/** Talks to clamd: zINSTREAM, length-prefixed chunks, zero-length terminator. */
export function clamavScanner(host: string, port: number, timeoutMs = 30_000): FileScanner {
  return {
    name: "clamav",
    scan: (data) =>
      new Promise<ScanResult>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const chunks: Buffer[] = [];
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error("ClamAV did not answer in time")));
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          for (let offset = 0; offset < data.length; offset += 64 * 1024) {
            const part = data.subarray(offset, offset + 64 * 1024);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(part.length);
            socket.write(size);
            socket.write(part);
          }
          socket.write(Buffer.alloc(4));
        });
        socket.on("data", (d: Buffer) => chunks.push(d));
        socket.on("error", reject);
        socket.on("end", () => {
          const reply = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
          if (reply.endsWith("OK")) resolve({ clean: true, detail: "clamav: OK" });
          else if (reply.endsWith("FOUND")) resolve({ clean: false, detail: `clamav: ${reply.replace(/^stream:\s*/, "").slice(0, 200)}` });
          else reject(new Error(`Unexpected ClamAV reply: ${reply.slice(0, 200)}`));
        });
      }),
  };
}

/** Returns null when no scanner is configured. */
export function fileScannerFromEnv(env: NodeJS.ProcessEnv): FileScanner | null {
  const driver = (env.FILE_SCANNER ?? "none").trim() || "none";
  if (driver === "none") return null;
  if (driver === "dev-allow") {
    if (env.EXAMIO_ENV === "production" || env.EXAMIO_ENV === "staging") {
      throw new Error("FILE_SCANNER=dev-allow is not allowed in staging or production. Configure clamav.");
    }
    return devAllowScanner();
  }
  if (driver === "clamav") {
    const port = Number(env.CLAMAV_PORT ?? "3310");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLAMAV_PORT must be a port number.");
    return clamavScanner(env.CLAMAV_HOST?.trim() || "127.0.0.1", port);
  }
  throw new Error(`FILE_SCANNER "${driver}" is not supported. Supported: none, dev-allow, clamav.`);
}
