import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Phase 13.1: admissions. Runs after setup.spec.ts (files run in name order with one worker):
 * a current academic year with Class 1 A exists in each project's demo school.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

test("the office takes an enquiry through review and approval and enrolls the student once", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  await page.goto("/school/admissions", { waitUntil: "networkidle" });
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Record" }) });
  await form.getByLabel("Class applied for").selectOption({ label: "Class 1" });
  await form.getByLabel("Applicant's full name").fill(`Tara ${tag}`);
  await form.getByLabel("Date of birth").fill("2020-04-12");
  await form.getByLabel("Guardian's name").fill(`Vikram ${tag}`);
  await form.getByLabel("Guardian's mobile").fill("9812345678");
  await form.getByRole("button", { name: "Record" }).click();
  await expect(page.getByRole("heading", { name: `Tara ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Application received" }).click();
  await expect(page.getByText("Applied", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByText("Under review", { exact: true }).first()).toBeVisible();

  // Approval waits for the required documents.
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Verify or waive the required documents" })).toBeVisible();
  for (const doc of ["Birth certificate", "Photograph", "Address proof"]) {
    const item = page.locator("li").filter({ has: page.getByRole("button", { name: `Save ${doc}` }) });
    await item.getByLabel("Status").selectOption("verified");
    await item.getByRole("button", { name: `Save ${doc}` }).click();
    await expect(item.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  }
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  // Enroll: the student account is created once, with an activation code.
  await page.getByLabel("Admission number").fill(`AD-${tag}`);
  await page.getByLabel("Section of Class 1 (optional)").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Create student" }).click();
  await expect(page.getByTestId("one-time-code")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Enrolled", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Open the student record" }).click();
  await expect(page.getByRole("heading", { name: `Tara ${tag}` })).toBeVisible();
  await expect(page.getByText(`AD-${tag}`).first()).toBeVisible();
});
