import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 10: practice. Runs after setup.spec.ts (files run in name order with one worker): "Class 1 A"
 * with Mathematics exists in each project's demo school. The test writes its own question.
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

test("a teacher builds and assigns a practice set; a student practises, submits and sees feedback and progress", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `PR-${tag}`;
  const username = `${s.code}.${admission.toLowerCase()}`;
  const title = `Place value practice ${tag}`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  // A published question.
  await page.goto("/school/questions/new", { waitUntil: "networkidle" });
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByRole("button", { name: "Change subject" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Question", { exact: true }).fill(`Place value of 5 in 352 (${tag})`);
  await page.getByLabel("Option A", { exact: true }).fill("5");
  await page.getByLabel("Option B", { exact: true }).fill("50");
  await page.getByLabel("Option C", { exact: true }).fill("500");
  await page.getByLabel("Option B is correct").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Question saved.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();

  // A student in Class 1 A.
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Kabir ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();

  // Build, publish and assign the set.
  await page.goto("/school/practice", { waitUntil: "networkidle" });
  const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create" }) });
  await create.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await create.getByLabel("Title").fill(title);
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByLabel("Search question text").fill(tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("checkbox", { name: new RegExp(`Place value of 5 in 352 \\(${tag}\\)`) }).check();
  await page.getByRole("button", { name: "Add selected" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 1 question(s)." })).toBeVisible();
  await page.getByRole("button", { name: "Publish set" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Section", { exact: true }).selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Class 1 A" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: new RegExp(`Kabir ${tag}`) })).toBeVisible();
  await signOut(page);

  // The student practises: a wrong answer, changed to the right one, then submitted.
  await redeem(page, code, "Kabir#Learn26");
  await signIn(page, username, "Kabir#Learn26");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/practice", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Start ${title}` }).click();
  await expect(page).toHaveURL(/\/student\/practice\/attempts\//);
  await page.waitForLoadState("networkidle");
  await page.getByRole("radio", { name: "A. 5", exact: true }).check();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "B. 50", exact: true }).check();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText("1 of 1 answered")).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect(page.getByText("Your answers have been submitted.")).toBeVisible();
  await expect(page.getByText(/Score: 1 of 1 · 1 of 1 correct/)).toBeVisible();
  await expect(page.getByText("Correct", { exact: true })).toBeVisible();

  // Progress: one answer is not enough to judge a topic yet.
  await page.goto("/student/progress");
  await expect(page.getByText("Not enough practice yet")).toBeVisible();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
});
