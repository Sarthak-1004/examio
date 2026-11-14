import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 5: students and parents. Runs after setup.spec.ts in each browser project (files run in
 * name order with one worker), which made 2026-27 current and created "Class 1 A" in that
 * project's demo school.
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

test("an admin admits a student and adds a parent; each signs in and sees only their own", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `E2E-${tag}`;
  const username = `${s.code}.${admission.toLowerCase()}`;
  const parentEmail = `parent-${tag}@family.demo`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/students");
  await page.getByLabel("Full name", { exact: true }).fill(`Ishaan ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByLabel("Roll number", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Admit student" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Sign-in name: ${username}` })).toBeVisible();
  const studentCode = (await page.getByTestId("one-time-code").innerText()).trim();

  // The same admission number (any case) is refused.
  await page.getByLabel("Full name", { exact: true }).fill("Someone Else");
  await page.getByLabel("Admission number", { exact: true }).fill(admission.toLowerCase());
  await page.getByRole("button", { name: "Admit student" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already has this admission number" })).toBeVisible();

  // Open the student and add a parent account.
  await page.getByLabel("Search name, admission number or sign-in name").fill(tag);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Ishaan ${tag}` }).click();
  await expect(page.getByRole("heading", { name: `Ishaan ${tag}` })).toBeVisible();
  await expect(page.getByText("Class 1 A").first()).toBeVisible();
  await page.getByLabel("Parent's name").fill(`Neha ${tag}`);
  await page.getByLabel("Parent's email").fill(parentEmail);
  await page.getByLabel("Relationship", { exact: true }).first().selectOption("mother");
  await page.getByRole("button", { name: "Add parent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "added as a parent" })).toBeVisible();
  const parentCode = (await page.getByTestId("one-time-code").innerText()).trim();
  await signOut(page);

  // The student activates the account and signs in with the sign-in name.
  await redeem(page, studentCode, "Ishaan#Learn26");
  await signIn(page, username.toUpperCase(), "Ishaan#Learn26");
  await expect(page).toHaveURL(/\/student$/);
  await expect(page.getByText("Class 1 A · Roll 1")).toBeVisible();
  await signOut(page);

  // The parent sees this child, and nothing of the school's records.
  await redeem(page, parentCode, "Neha#Parent26");
  await signIn(page, parentEmail, "Neha#Parent26");
  await expect(page).toHaveURL(/\/parent$/);
  await page.getByRole("link", { name: `Ishaan ${tag}` }).first().click();
  await expect(page.getByRole("heading", { name: `Ishaan ${tag}` })).toBeVisible();
  await expect(page.getByText("Class 1 A").first()).toBeVisible();
  await page.goto("/parent/children/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
  await page.goto("/school/students");
  await expect(page).not.toHaveURL(/\/school\/students/);
});

test("an admin imports a class list once; checking the same file again shows the duplicates", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  await signIn(page, school(info.project.name).admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  const csv = `Student Name,Adm No,DOB,Class,Section,Roll No\nImported A ${tag},IMPA-${tag},2019-04-02,Class 1,A,41\nImported B ${tag},IMPB-${tag},,Class 1,A,42`;

  await page.goto("/school/students/import");
  await page.getByLabel("Or paste CSV").fill(csv);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("2 ready, 0 with errors")).toBeVisible();
  await page.getByRole("button", { name: "Import 2 student(s)" }).click();
  await expect(page.getByRole("heading", { name: "Imported 2 student(s)" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Activation codes" }).getByRole("row")).toHaveCount(3);

  await page.goto("/school/students/import");
  await page.getByLabel("Or paste CSV").fill(csv);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("0 ready, 2 with errors")).toBeVisible();
  await expect(page.getByText("A student with this admission number already exists.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Import \d+ student/ })).toHaveCount(0);

  // Class strength counts the imported students.
  await page.goto("/school/students/reports");
  await page.getByRole("link", { name: "Class 1 A" }).click();
  await expect(page.getByText(`Imported A ${tag}`)).toBeVisible();
});
