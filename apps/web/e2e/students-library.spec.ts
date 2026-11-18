import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 13.2: library. Runs after setup.spec.ts (files run in name order with one worker):
 * "Class 1 A" exists in each project's demo school.
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

test("the library desk catalogues a book, issues it once, renews and takes it back; the student sees the loan", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `LB-${tag}`;
  const title = `Panchatantra ${tag}`;
  const acc = `ACC-${tag}`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Meera ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();

  // Catalogue a title with two copies.
  await page.goto("/school/library/catalogue", { waitUntil: "networkidle" });
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Author (optional)").fill("Vishnu Sharma");
  await page.getByLabel("Accession numbers of the copies").fill(`${acc}, ${acc}-2`);
  await page.getByRole("button", { name: "Add title" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `${acc}-2` }).getByText("On the shelf")).toBeVisible();

  // Issue; the same copy cannot go out twice.
  await page.goto("/school/library", { waitUntil: "networkidle" });
  const issue = page.locator("form").filter({ has: page.getByRole("button", { name: "Issue", exact: true }) });
  await issue.getByLabel("Accession number").fill(acc.toLowerCase());
  await issue.getByLabel("Borrower (admission or employee number)").fill(admission);
  await issue.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(issue.getByRole("status")).toContainText(`Issued “${title}” to Meera ${tag}`);
  await issue.getByLabel("Accession number").fill(acc);
  await issue.getByLabel("Borrower (admission or employee number)").fill(admission);
  await issue.getByRole("button", { name: "Issue", exact: true }).click();
  await expect(issue.getByRole("alert")).toContainText("already on loan");

  const row = page.getByRole("row").filter({ hasText: `${title} · ${acc}` });
  await row.getByRole("button", { name: `Renew ${acc}` }).click();
  await expect(row.getByRole("status")).toContainText("Renewed");
  await signOut(page);

  // The student sees the book on loan.
  await redeem(page, code, "Meera#Read2026");
  await signIn(page, `${s.code}.${admission.toLowerCase()}`, "Meera#Read2026");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/library");
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText(/^Due /)).toBeVisible();
  await signOut(page);

  // Return at the desk.
  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/library", { waitUntil: "networkidle" });
  const ret = page.locator("form").filter({ has: page.getByRole("button", { name: "Return", exact: true }) });
  await ret.getByLabel("Accession number").fill(acc);
  await ret.getByRole("button", { name: "Return", exact: true }).click();
  await expect(ret.getByRole("status")).toContainText(`Returned “${title}”.`);
  await expect(page.getByRole("row").filter({ hasText: acc })).toHaveCount(0);
});
