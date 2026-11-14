import { test } from "@playwright/test";
import { signInSuper } from "./helpers";

// Not an assertion test — captures screenshots for visual review. Run with: pnpm exec playwright test screenshots
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture");

test("capture key screens", async ({ page }, info) => {
  const out = (n: string) => `${process.env.SCREENSHOTS}/${info.project.name}-${n}.png`;
  await page.goto("/login");
  await page.screenshot({ path: out("login"), fullPage: true });
  await signInSuper(page);
  await page.screenshot({ path: out("schools"), fullPage: true });
  await page.goto("/admin/schools/new");
  await page.screenshot({ path: out("new-school"), fullPage: true });
});
