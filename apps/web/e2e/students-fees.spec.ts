import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 8: fees. Runs after setup and staff (files run in name order with one worker): the
 * 2026-27 year is current and "Class 1 A" exists in each project's demo school. Online payment
 * uses the sandbox provider (test mode): the "Complete test payment" button sends a signed event
 * through the same webhook processing as Razorpay.
 */
const school = (name: string) => (name === "desktop" ? { admin: "principal@gvps.demo", code: "gvps" } : { admin: "principal@srv.demo", code: "srv" });

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

test("fees: set up, approve, invoice, take a cash payment, and the parent pays the rest online", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const parentEmail = `fee-parent-${tag}@family.demo`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  // A student with a parent account.
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Arjun ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(`FEE-${tag}`);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  await expect(page.getByTestId("one-time-code")).toBeVisible();
  await page.getByLabel("Search name, admission number or sign-in name").fill(tag);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Arjun ${tag}` }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Parent's name").fill(`Kiran ${tag}`);
  await page.getByLabel("Parent's email").fill(parentEmail);
  await page.getByRole("button", { name: "Add parent" }).click();
  const parentCode = (await page.getByTestId("one-time-code").innerText()).trim();

  // Fee head, structure, item, approval, invoices.
  await page.goto("/school/fees/setup", { waitUntil: "networkidle" });
  await page.getByLabel("Fee head name").fill(`Tuition ${tag}`);
  await page.getByRole("button", { name: "Add fee head" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Fee head added." })).toBeVisible();
  await page.getByLabel("Class", { exact: true }).selectOption({ label: "Class 1" });
  await page.getByLabel("Name", { exact: true }).fill(`Fees ${tag}`);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Fee structure created as a draft" })).toBeVisible();
  await page.getByRole("link", { name: `Class 1: Fees ${tag}` }).click();
  await expect(page).toHaveURL(/\/school\/fees\/structures\//);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Fee head", { exact: true }).selectOption({ label: `Tuition ${tag}` });
  await page.getByLabel("Label").fill("Term 1");
  await page.getByLabel("Amount (₹)").fill("1500");
  await page.getByLabel("Due on").fill(due);
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Item added." })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  // Approving replaces the form with the billing buttons, so check the badge rather than the message.
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Issue instalment due ${due}` }).click();
  await expect(page.getByRole("status").filter({ hasText: /invoice\(s\) issued/ })).toBeVisible();

  // A cash part-payment at the office.
  await page.goto(`/school/fees?q=${encodeURIComponent(`FEE-${tag}`)}`);
  await page.getByRole("link", { name: `Arjun ${tag}` }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Amount (₹)").first().fill("500");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Receipt RCT-\d{6}/ })).toBeVisible();
  await signOut(page);

  // The parent pays the rest online (test mode) and opens the receipt.
  await redeem(page, parentCode, "Kiran#Parent26");
  await signIn(page, parentEmail, "Kiran#Parent26");
  await expect(page).toHaveURL(/\/parent$/);
  await page.goto("/parent/fees", { waitUntil: "networkidle" });
  await expect(page.getByText("₹1,000.00 due").first()).toBeVisible();
  await page.getByRole("button", { name: "Pay ₹1,000.00" }).click();
  await page.getByRole("button", { name: "Complete test payment" }).click();
  // Once paid, the invoice has no Pay button (and so no message): the statement shows it instead.
  await expect(page.getByText("Nothing due")).toBeVisible();
  await page.getByRole("link", { name: /RCT-\d{6} · Online/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("₹1,000.00")).toBeVisible();
});
