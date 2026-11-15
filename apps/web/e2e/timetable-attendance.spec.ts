import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Phase 6: attendance and timetable. Runs after setup, staff and students (files run in name
 * order with one worker): "Class 1 A" exists with Mathematics and students in each project's
 * demo school.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

test("an admin takes today's register, adds timetable periods and sees a clash refused", async ({ page }, info) => {
  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  // Make every day a school day, so the test does not depend on today's weekday.
  await page.goto("/school/attendance");
  for (const box of await page.getByRole("checkbox", { checked: true }).all()) await box.uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Attendance settings saved." })).toBeVisible();
  await page.reload();

  await page.getByRole("link", { name: /^Class 1 A/ }).first().click();
  await expect(page.getByRole("heading", { name: /^Class 1 A · \d{4}-\d{2}-\d{2}$/ })).toBeVisible();
  const rows = page.getByRole("group");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  await rows.first().getByText("Absent", { exact: true }).click();
  await page.getByRole("button", { name: /^Save (register|changes)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Register saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Taken", { exact: true })).toBeVisible();
  await expect(rows.first().getByRole("radio", { name: "Absent" })).toBeChecked();

  // Today's attendance appears in the report.
  await page.goto("/school/attendance/reports");
  await expect(page.getByRole("table", { name: "Attendance by student" })).toBeVisible();

  // Timetable: one period, then a clash for the same section is refused with an explanation.
  await page.goto("/school/timetable");
  await page.getByLabel("Section", { exact: true }).selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByLabel("Day").selectOption({ label: "Tuesday" });
  await page.getByLabel("Starts").fill("10:00");
  await page.getByLabel("Ends").fill("10:40");
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByLabel("Room").fill(`R-${info.project.name}`);
  await page.getByRole("button", { name: "Add period" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Period added." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tuesday" }).getByText("Mathematics")).toBeVisible();
  await page.getByLabel("Starts").fill("10:20");
  await page.getByLabel("Ends").fill("11:00");
  await page.getByRole("button", { name: "Add period" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This section already has a period at that time" })).toBeVisible();
});
