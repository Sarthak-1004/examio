import { describe, expect, it } from "vitest";
import { RESTORE_REHEARSAL_DATABASE, assertDisposableDatabase } from "@examio/db";

/** Phase 2, task 02.2: destructive test and maintenance commands only touch disposable databases. */
const env = {
  DATABASE_URL: "postgres://app:x@localhost:5432/examio",
  DATABASE_OWNER_URL: "postgres://owner:x@localhost:5432/examio",
};
const check = (url: string, opts: { allowRestoreRehearsal?: boolean } = {}) => () => assertDisposableDatabase(url, "test", { ...opts, env });

describe("disposable database guard", () => {
  it("accepts local *_test and *_e2e databases", () => {
    expect(check("postgres://u:p@localhost:5432/examio_test")).not.toThrow();
    expect(check("postgres://u:p@127.0.0.1:5433/examio_e2e")).not.toThrow();
    expect(check("postgres://u:p@[::1]/other_test")).not.toThrow();
  });

  it("refuses remote hosts, other names and the development database", () => {
    expect(check("postgres://u:p@db.example.com:5432/examio_test")).toThrow(/not on this machine/);
    expect(check("postgres://u:p@localhost:5432/examio")).toThrow(/does not end in _test or _e2e/);
    expect(check("postgres://u:p@localhost:5432/examio_test_backup")).toThrow(/does not end/);
    expect(check("not a url")).toThrow(/could not be parsed/);
    const devNamedTest = { DATABASE_URL: "postgres://a:b@localhost:5432/examio_test" };
    expect(() => assertDisposableDatabase("postgres://o:p@localhost/examio_test", "test", { env: devNamedTest })).toThrow(/named by DATABASE_URL/);
  });

  it("allows the restore rehearsal database only when asked", () => {
    const url = `postgres://u:p@localhost:5432/${RESTORE_REHEARSAL_DATABASE}`;
    expect(check(url)).toThrow();
    expect(check(url, { allowRestoreRehearsal: true })).not.toThrow();
  });
});
