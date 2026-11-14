import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** Phase 3: a school admin prepares a school year from the setup screens, without scripts. */
test("a school admin sets up a new academic year end to end", async ({ page }, info) => {
  // Each browser project uses its own demo school, so the runs do not see each other's data.
  const email = info.project.name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo";
  await signIn(page, email, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await expect(page.getByRole("heading", { name: "School setup" })).toBeVisible();

  await page.goto("/school/setup");
  await expect(page.getByText("In progress")).toBeVisible();

  // Academic year: invalid dates are refused, then a valid year is created and made current.
  await page.goto("/school/setup/years");
  await page.getByLabel("Name", { exact: true }).fill("2026-27");
  await page.getByLabel("Starts").fill("2026-04-01");
  await page.getByLabel("Ends").fill("2026-03-01");
  await page.getByRole("button", { name: "Create year" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "must end after it starts" })).toBeVisible();
  await page.getByLabel("Ends").fill("2027-03-31");
  await page.getByRole("button", { name: "Create year" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Year created." })).toBeVisible();
  await page.getByRole("button", { name: "Make 2026-27 current" }).click();
  // The button disappears once the year is current; the badge shows the new status.
  await expect(page.getByRole("button", { name: "Make 2026-27 current" })).toBeHidden();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();

  // Classes and a section; a duplicate section name is refused.
  await page.goto("/school/setup/classes");
  await page.getByRole("button", { name: "Add Class 1 to Class 12" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 12 class(es)." })).toBeVisible();
  await page.getByLabel("New section name for Class 1", { exact: true }).fill("A");
  await page.getByLabel("New section name for Class 1", { exact: true }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Section added." })).toBeVisible();
  await page.getByLabel("New section name for Class 1", { exact: true }).fill("a");
  await page.getByLabel("New section name for Class 1", { exact: true }).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "already has a section with that name" })).toBeVisible();

  // A subject, assigned to Class 1.
  await page.goto("/school/setup/subjects");
  await page.getByLabel("Subject name").fill("Mathematics");
  await page.getByLabel("Code").fill("math");
  await page.getByRole("button", { name: "Add subject" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Subject added." })).toBeVisible();
  await page.getByRole("checkbox", { name: "Mathematics" }).check();
  await page.getByRole("button", { name: "Save subjects for Class 1", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 added" })).toBeVisible();

  // Grading from the preset.
  await page.goto("/school/setup/grading");
  await page.getByRole("button", { name: "Use CBSE-style scale" }).click();
  await expect(page.getByRole("table", { name: "Grades in CBSE-style (A1–E)" })).toBeVisible();
  await expect(page.getByText("Default")).toBeVisible();

  // History is protected: a class in use cannot be deleted, only archived.
  await page.goto("/school/setup/classes");
  await page.getByRole("button", { name: "Delete Class 1", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "is in use" })).toBeVisible();

  // The overview reflects the progress.
  await page.goto("/school/setup");
  await expect(page.getByText("Current year: 2026-27.")).toBeVisible();
});
