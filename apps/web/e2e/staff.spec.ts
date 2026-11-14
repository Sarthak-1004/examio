import { expect, test } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 4: staff management. Runs after setup.spec.ts in each browser project (files run in
 * name order with one worker), which created "Class 1 A" with Mathematics in that project's
 * demo school.
 */
test("an admin adds and assigns a teacher, who then sees their class", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const adminEmail = info.project.name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo";
  const teacherEmail = `teacher-${tag}@staff.demo`;

  await signIn(page, adminEmail, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/staff");
  await page.getByLabel("Full name", { exact: true }).fill(`Kavya ${tag}`);
  await page.getByLabel("Employee number", { exact: true }).fill(`E2E-${tag}`);
  await page.getByLabel("Email", { exact: true }).fill(teacherEmail);
  await page.getByRole("button", { name: "Add staff member" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

  // Duplicate employee numbers are refused with an explanation.
  await page.getByLabel("Full name", { exact: true }).fill("Someone Else");
  await page.getByLabel("Employee number", { exact: true }).fill(`e2e-${tag}`);
  await page.getByLabel("Email", { exact: true }).fill(`other-${tag}@staff.demo`);
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already has this employee number" })).toBeVisible();

  // Assign Class 1 A Mathematics.
  await page.getByLabel("Search name, number, email or phone").fill(tag);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Kavya ${tag}` }).click();
  await expect(page.getByRole("heading", { name: `Kavya ${tag}` })).toBeVisible();
  await page.getByLabel("Section", { exact: true }).first().selectOption({ label: "Class 1 A" });
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Assigned from" })).toBeVisible();
  await expect(page.getByText("Class 1 A").first()).toBeVisible();
  await signOut(page);

  // The teacher activates the account and sees today's class.
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill("Kavya#Teach2026");
  await page.getByLabel("Confirm new password").fill("Kavya#Teach2026");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await signIn(page, teacherEmail, "Kavya#Teach2026");
  await expect(page).toHaveURL(/\/school$/);
  const today = page.getByRole("heading", { name: "My classes today" }).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
  await expect(today.getByText("Class 1 A")).toBeVisible();
  await expect(today.getByText("Mathematics")).toBeVisible();

  // Staff management is for administrators only.
  await page.goto("/school/staff");
  await expect(page).not.toHaveURL(/\/school\/staff/);
});

test("an admin imports staff from CSV once; the same file cannot be imported twice", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  await signIn(page, info.project.name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  const csv = `name,employee_no,email,role\nImported ${tag},IMP-${tag},imp-${tag}@staff.demo,teacher`;

  await page.goto("/school/staff/import");
  await page.getByLabel("Or paste CSV").fill(csv);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("1 ready, 0 with errors")).toBeVisible();
  await page.getByRole("button", { name: "Import 1 staff member(s)" }).click();
  await expect(page.getByRole("heading", { name: "Imported 1 staff member(s)" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Activation codes" }).getByRole("row")).toHaveCount(2);

  await page.goto("/school/staff/import");
  await page.getByLabel("Or paste CSV").fill(csv);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("0 ready, 1 with errors")).toBeVisible();
  await expect(page.getByText("A staff member with this employee number already exists.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Import \d+ staff/ })).toHaveCount(0);
});
