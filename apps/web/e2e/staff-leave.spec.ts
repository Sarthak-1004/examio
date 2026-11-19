import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 14.2: staff leave and the staff register. Runs after setup.spec.ts (files run in name
 * order with one worker), which made the current academic year.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

/** Today in India, or tomorrow when today is a Sunday (the default weekly off day). */
function workingDay(): string {
  const now = new Date(Date.now() + 5.5 * 3600_000);
  if (now.getUTCDay() === 0) now.setUTCDate(now.getUTCDate() + 1);
  return now.toISOString().slice(0, 10);
}

test("a teacher requests leave, the principal approves it and the register shows it", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const email = `leave-${tag}@hr.demo`;
  const day = workingDay();

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/hr/leave", { waitUntil: "networkidle" });
  await page.getByLabel("Name", { exact: true }).fill(`Casual ${tag}`);
  await page.getByLabel("Days a year (paid)").fill("12");
  await page.getByRole("button", { name: "Add leave type" }).click();
  await expect(page.getByRole("row").filter({ hasText: `Casual ${tag}` })).toBeVisible();

  await page.goto("/school/staff", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Nandini ${tag}`);
  await page.getByLabel("Employee number", { exact: true }).fill(`LV-${tag}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Add staff member" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();
  await signOut(page);

  await redeem(page, code, "Nandini#Leave26");
  await signIn(page, email, "Nandini#Leave26");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/my-leave", { waitUntil: "networkidle" });
  await expect(page.getByText(`Casual ${tag}`).first()).toBeVisible();
  await page.getByLabel("Leave type").selectOption({ label: `Casual ${tag} (12 days a year)` });
  await page.getByLabel("From", { exact: true }).fill(day);
  await page.getByLabel("Reason").fill("Family function");
  await page.getByRole("button", { name: "Request leave" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Requested 1 working day(s)" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: day }).getByText("Pending")).toBeVisible();
  await signOut(page);

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/hr/leave", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Approve leave for Nandini ${tag} (LV-${tag})` }).click();
  // The request leaves the pending list and appears among the decisions.
  await expect(page.getByRole("region", { name: "Decided leave requests" }).getByRole("row").filter({ hasText: `Nandini ${tag}` }).getByText("Approved")).toBeVisible();

  await page.goto(`/school/hr/attendance?date=${day}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("listitem").filter({ hasText: `Nandini ${tag}` }).getByText(`On leave · Casual ${tag}`)).toBeVisible();
});
