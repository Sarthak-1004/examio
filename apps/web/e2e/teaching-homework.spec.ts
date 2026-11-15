import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 7: homework, submissions, feedback and notices. Runs after setup, staff and students
 * (files run in name order with one worker): "Class 1 A" with Mathematics exists in each
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

test("homework goes from teacher to student and back with feedback; class notices reach the class", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `HW-${tag}`;
  const username = `${s.code}.${admission.toLowerCase()}`;
  const title = `Fractions ${tag}`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Meera ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();

  await page.goto("/school/homework", { waitUntil: "networkidle" });
  await page.getByRole("checkbox", { name: "Class 1 A" }).check();
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Instructions").fill("Questions 1 to 10.");
  await page.getByRole("button", { name: "Set homework" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Homework set for 1 section(s)" })).toBeVisible();

  await page.goto("/school/announcements", { waitUntil: "networkidle" });
  await page.getByLabel("To").selectOption("section");
  await page.getByLabel("Class").selectOption({ label: "Class 1 A" });
  await page.getByLabel("Title").fill(`Bring compasses ${tag}`);
  await page.getByLabel("Message").fill("For tomorrow's geometry lesson.");
  await page.getByRole("button", { name: "Publish notice" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Notice published" })).toBeVisible();
  await signOut(page);

  // The student sees the homework and the notice, and submits.
  await redeem(page, code, "Meera#Learn26");
  await signIn(page, username, "Meera#Learn26");
  await expect(page).toHaveURL(/\/student$/);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByText(`Bring compasses ${tag}`)).toBeVisible();
  await page.getByRole("link", { name: title }).click();
  await page.getByLabel("Your answer").fill("1) 3/4 2) 5/8");
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Submitted." })).toBeVisible();
  await signOut(page);

  // The admin returns feedback.
  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/homework");
  await page.getByRole("link", { name: title }).click();
  await page.getByLabel(`Feedback for Meera ${tag}`).fill("Well done. Check question 2.");
  await page.getByRole("button", { name: "Return feedback" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Feedback returned." })).toBeVisible();
  await signOut(page);

  // The student reads the feedback; the submission is now final.
  await signIn(page, username, "Meera#Learn26");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/homework");
  await page.getByRole("link", { name: title }).click();
  await expect(page.getByText("Well done. Check question 2.")).toBeVisible();
  await expect(page.getByText("Feedback has been returned, so the submission is final.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Submit|Update submission/ })).toHaveCount(0);
});
