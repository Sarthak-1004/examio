import { expect, test } from "@playwright/test";
import { signIn, signInSuper, signOut } from "./helpers";

/** Phase 15.2: the school reports page and the platform usage page. */
const school = (name: string) => (name === "desktop" ? { name: "Green Valley Public School", admin: "principal@gvps.demo" } : { name: "Sunrise Vidyalaya", admin: "principal@srv.demo" });

test("the principal sees reports across modules and downloads; the platform sees usage counts", async ({ page, request }, info) => {
  const s = school(info.project.name);
  expect((await request.get("/school/students/export")).status()).toBe(403);

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/reports", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByText("Students", { exact: true })).toBeVisible();
  await expect(page.getByText("Attendance (30 days)")).toBeVisible();
  const csv = await page.request.get("/school/students/export");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  await signOut(page);

  await signInSuper(page);
  await page.goto("/admin/usage", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`^${s.name} \\(`) })).toBeVisible();
});
