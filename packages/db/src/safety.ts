/**
 * Guards for destructive operations (truncating fixtures, dropping databases).
 *
 * A database is treated as disposable only when all of these hold:
 * - it is on this machine (localhost, 127.0.0.1 or ::1);
 * - its name ends in `_test` or `_e2e` (or, for the restore rehearsal, is exactly the
 *   rehearsal database name);
 * - it is not the database named by DATABASE_URL or DATABASE_OWNER_URL.
 *
 * Passing the guard does not prove the data is worthless; it makes it hard to point a
 * destructive command at the wrong database by mistake.
 */
export const RESTORE_REHEARSAL_DATABASE = "examio_restore_check";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface DatabaseIdentity {
  host: string;
  port: string;
  database: string;
}

export function databaseIdentity(url: string): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("A database URL could not be parsed (see .env.example).");
  }
  return { host: parsed.hostname.toLowerCase(), port: parsed.port || "5432", database: decodeURIComponent(parsed.pathname.slice(1)) };
}

const same = (a: DatabaseIdentity, b: DatabaseIdentity) => a.host === b.host && a.port === b.port && a.database === b.database;

export function assertDisposableDatabase(
  url: string,
  purpose: string,
  opts: { allowRestoreRehearsal?: boolean; env?: NodeJS.ProcessEnv } = {},
): DatabaseIdentity {
  const env = opts.env ?? process.env;
  const id = databaseIdentity(url);
  const refuse = (why: string): never => {
    throw new Error(`Refusing to ${purpose}: database "${id.database}" on ${id.host} ${why}.`);
  };
  if (!LOCAL_HOSTS.has(id.host)) refuse("is not on this machine");
  const nameOk = /_(test|e2e)$/.test(id.database) || (opts.allowRestoreRehearsal === true && id.database === RESTORE_REHEARSAL_DATABASE);
  if (!nameOk) refuse("does not end in _test or _e2e");
  for (const name of ["DATABASE_URL", "DATABASE_OWNER_URL"] as const) {
    const other = env[name];
    if (other && same(id, databaseIdentity(other))) refuse(`is the database named by ${name}`);
  }
  return id;
}
