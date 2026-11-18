import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 11: formal exams. Runs after setup.spec.ts (files run in name order with one worker):
 * "Class 1 A" with Mathematics exists in each project's demo school, whose time zone is India.
 */
const school = (name: string) => (name === "desktop" ? { admin: "principal@gvps.demo", code: "gvps" } : { admin: "principal@srv.demo", code: "srv" });

/** "YYYY-MM-DDTHH:mm" in India time, `minutes` from now (for datetime-local inputs). */
function istLocal(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000 + 330 * 60_000);
  return d.toISOString().slice(0, 16);
}

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

test("an administrator builds and publishes an exam; a student sits it, marks a question, submits and gets a receipt", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `EX-${tag}`;
  const username = `${s.code}.${admission.toLowerCase()}`;
  const title = `Term test ${tag}`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  // Two published questions.
  for (const [stem, opts] of [
    [`Place value of 5 in 352 (${tag})`, ["5", "50", "500"]],
    [`Seven eights (${tag})`, ["54", "56", "64"]],
  ] as const) {
    await page.goto("/school/questions/new", { waitUntil: "networkidle" });
    await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
    await page.getByRole("button", { name: "Change subject" }).click();
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Question", { exact: true }).fill(stem);
    await page.getByLabel("Option A", { exact: true }).fill(opts[0]);
    await page.getByLabel("Option B", { exact: true }).fill(opts[1]);
    await page.getByLabel("Option C", { exact: true }).fill(opts[2]);
    await page.getByLabel("Option B is correct").check();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Question saved.")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Publish version 1" }).click();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  }

  // A student in Class 1 A.
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Zoya ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();

  // Build and publish the exam.
  await page.goto("/school/exams", { waitUntil: "networkidle" });
  const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create" }) });
  await create.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await create.getByLabel("Title").fill(title);
  await create.getByLabel("Opens").fill(istLocal(-5));
  await create.getByLabel("Closes").fill(istLocal(120));
  await create.getByLabel("Duration (minutes)").fill("30");
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByLabel("Search question text").fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("checkbox", { name: new RegExp(`Place value of 5 in 352 \\(${tag}\\)`) }).check();
  await page.getByRole("checkbox", { name: new RegExp(`Seven eights \\(${tag}\\)`) }).check();
  await page.getByRole("button", { name: "Add selected" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 2 question(s)." })).toBeVisible();
  await page.getByRole("checkbox", { name: "Class 1 A" }).check();
  await page.getByRole("button", { name: "Save sections" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sections saved (1)." })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  await signOut(page);

  // The student sits the exam.
  await redeem(page, code, "Zoya#Learn26");
  await signIn(page, username, "Zoya#Learn26");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/exams", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Start ${title}` }).click();
  await expect(page).toHaveURL(/\/student\/exams\/attempts\//);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("timer")).toContainText(/\d+:\d{2}/);
  // Question 1 is the first one ticked in the bank list (newest first): "Seven eights".
  await expect(page.getByText(`Seven eights (${tag})`)).toBeVisible();
  await page.getByRole("radio", { name: "B. 56", exact: true }).check();
  await expect(page.getByText("All answers saved")).toBeVisible();
  await page.getByRole("button", { name: "Mark for review" }).click();
  await expect(page.getByRole("button", { name: "Unmark review" })).toBeVisible();
  // Refreshing keeps the acknowledged answer.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("radio", { name: "B. 56", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Review and submit" }).first().click();
  await expect(page.getByText("1 of 2 questions answered.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Question 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Submit exam" }).click();
  await expect(page.getByText("Your exam has been submitted.")).toBeVisible();
  await expect(page.getByTestId("exam-receipt")).toHaveText(/^[0-9A-F]{10}$/);
  await signOut(page);

  // Staff see the submission.
  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/exams");
  await page.getByRole("link", { name: title }).click();
  const row = page.getByRole("row").filter({ hasText: `Zoya ${tag}` });
  await expect(row.getByText("Submitted")).toBeVisible();
  await expect(row.getByText("1 of 2")).toBeVisible();
});
