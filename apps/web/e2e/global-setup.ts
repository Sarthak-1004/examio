import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The browser-test database is recreated for every run, so no authenticator code has been
 * used yet: forget the step remembered from earlier runs (see signInSuper in foundation.spec.ts).
 */
export default function globalSetup(): void {
  fs.rmSync(path.join(os.tmpdir(), "examio-e2e-super-totp-step"), { force: true });
}
