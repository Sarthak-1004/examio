import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** Phase 14.1: HR records. Independent of other specs except the demo schools and their admins. */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

test("an administrator records employment, history, payment details and an HR document", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/staff", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Lakshmi ${tag}`);
  await page.getByLabel("Employee number", { exact: true }).fill(`HR-${tag}`);
  await page.getByLabel("Email", { exact: true }).fill(`lakshmi-${tag}@hr.demo`);
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByTestId("one-time-code")).toBeVisible();

  await page.goto("/school/hr", { waitUntil: "networkidle" });
  await page.getByLabel("New department").fill(`Languages ${tag}`);
  await page.getByRole("button", { name: "Add department" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `Languages ${tag}` })).toBeVisible();
  await page.getByLabel("New designation").fill(`TGT ${tag}`);
  await page.getByRole("button", { name: "Add designation" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `TGT ${tag}` })).toBeVisible();

  await page.getByLabel("Search name or employee number").fill(`HR-${tag}`);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Lakshmi ${tag} (HR-${tag})` }).click();
  await expect(page.getByRole("heading", { name: `Lakshmi ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Employment type").selectOption("probation");
  await page.getByLabel("Department").selectOption({ label: `Languages ${tag}` });
  await page.getByLabel("Designation").selectOption({ label: `TGT ${tag}` });
  await page.getByLabel("Change takes effect on").fill("2026-06-01");
  await page.getByRole("button", { name: "Save employment" }).click();
  await expect(page.getByRole("status").filter({ hasText: "3 changes added to the history" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `— → Languages ${tag}` })).toBeVisible();

  await page.getByLabel("Account number").fill("12345678901234");
  await page.getByLabel("IFSC").fill("hdfc0001234");
  await page.getByRole("button", { name: "Save payment details" }).click();
  await expect(page.getByText("Account ending 1234 · HDFC0001234")).toBeVisible();

  await page.getByLabel("File (PDF or image, up to 10 MB)").setInputFiles({ name: "appointment.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%e2e\n") });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Document added." })).toBeVisible();
  await expect(page.getByText("appointment.pdf")).toBeVisible();
});
