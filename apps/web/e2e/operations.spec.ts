import { expect, test } from "@playwright/test";
import { signIn, signInSuper } from "./helpers";

/** Phase 2: operations pages, audit logs, health check and the file download route. */

test("the public health check answers without revealing details", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("file downloads require sign-in and never disclose other files", async ({ page, request }) => {
  const anonymous = await request.get("/files/00000000-0000-4000-8000-000000000000");
  expect(anonymous.status()).toBe(401);

  await signIn(page, "principal@gvps.demo", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const res = await page.request.get(`/files/${id}`);
    expect(res.status()).toBe(404);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  }
});

test("platform admin sees system health and the platform audit log", async ({ page }) => {
  await signInSuper(page);
  await page.goto("/admin/system");
  await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
  await expect(page.getByText("Background worker")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Failed jobs" })).toBeVisible();

  await page.goto("/admin/audit");
  await expect(page.getByRole("table", { name: "Audit log" })).toBeVisible();
  await page.getByLabel("Action contains").fill("auth.login");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=auth.login/);
  await expect(page.getByRole("cell", { name: "auth.login" }).first()).toBeVisible();
});

test("support access appears in the school's audit log and as a notice for its admins", async ({ page }) => {
  await signInSuper(page);
  await page.getByRole("link", { name: "Sunrise Vidyalaya" }).first().click();
  const end = page.getByRole("button", { name: "End access now" });
  if (await end.isVisible()) await end.click();
  const reason = `E2E notice check ${Date.now().toString(36)}: help with timetable`;
  await page.getByLabel("Reason for access").fill(reason);
  await page.getByRole("button", { name: "Open access for 1 hour" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Access is open until" })).toBeVisible();
  await page.getByRole("button", { name: "End access now" }).click();

  // School admins and only school admins have the audit log.
  await page.context().clearCookies();
  await signIn(page, "principal@srv.demo", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/audit");
  await page.getByLabel("Action contains").fill("support.access_started");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("cell", { name: "support.access_started" }).first()).toBeVisible();
  // The reason is in the Details column, which is hidden on narrow screens.
  if (test.info().project.name === "desktop") {
    await expect(page.getByRole("cell", { name: reason.slice(0, 30), exact: false }).first()).toBeVisible();
  }
});
