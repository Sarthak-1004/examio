import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Locates and runs PostgreSQL command-line tools (pg_dump, pg_restore) without putting the
 * password on the command line: it goes through the PGPASSWORD environment variable of the
 * child process only.
 */
export function connectionArgs(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const args = ["--host", u.hostname, "--port", u.port || "5432", "--username", decodeURIComponent(u.username), "--dbname", decodeURIComponent(u.pathname.slice(1))];
  return { args, env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) } };
}

/** PG_BIN_DIR, then the default Windows install folder for the server's major version, then PATH. */
export function findTool(tool: "pg_dump" | "pg_restore", serverMajor: number): string {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const candidates = [
    process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, exe) : null,
    process.platform === "win32" ? path.join("C:\\Program Files\\PostgreSQL", String(serverMajor), "bin", exe) : null,
  ].filter((c): c is string => c !== null);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return exe; // rely on PATH
}

export function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => reject(new Error(`Could not start ${path.basename(command)}: ${e.message}. Set PG_BIN_DIR to the PostgreSQL bin folder.`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim().slice(0, 500)}`))));
  });
}

/** The single row a query must return; throws instead of silently continuing without it. */
export function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Query for ${what} returned no row`);
  return row;
}
