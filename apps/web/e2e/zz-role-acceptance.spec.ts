import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 15.4: role acceptance. Every role opens every page in its navigation; none may show an
 * error page, and (desktop) none may have serious or critical accessibility violations found by
 * axe. Runs last (file name), after setup.spec.ts created "Class 1 A".
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

const PAGES = {
  admin: [
    "/school", "/school/setup", "/school/students", "/school/admissions", "/school/library", "/school/library/catalogue", "/school/inventory", "/school/transport",
    "/school/staff", "/school/hr", "/school/hr/leave", "/school/hr/attendance", "/school/attendance", "/school/attendance/reports", "/school/homework",
    "/school/announcements", "/school/timetable", "/school/fees", "/school/fees/reports", "/school/payroll", "/school/payroll/salaries", "/school/payroll/adjustments",
    "/school/questions", "/school/practice", "/school/exams", "/school/results", "/school/my-leave", "/school/my-payslips", "/school/reports", "/school/subscription", "/school/audit",
  ],
  teacher: ["/school", "/school/classes", "/school/attendance", "/school/homework", "/school/announcements", "/school/timetable", "/school/questions", "/school/practice", "/school/exams", "/school/results", "/school/my-leave", "/school/my-payslips"],
  finance: ["/school/fees", "/school/fees/reports", "/school/payroll", "/school/payroll/salaries", "/school/payroll/adjustments", "/school/my-leave", "/school/my-payslips"],
  student: ["/student", "/student/homework", "/student/exams", "/student/practice", "/student/notices", "/student/timetable", "/student/attendance", "/student/results", "/student/library", "/student/transport", "/student/progress"],
  parent: ["/parent", "/parent/notices", "/parent/fees"],
};

const scanned = { pages: 0, minor: new Set<string>() };

async function visitAll(page: Page, role: string, paths: string[], scan: boolean) {
  const problems: string[] = [];
  for (const path of paths) {
    const res = await page.goto(path, { waitUntil: "networkidle" });
    if (!res || res.status() >= 400) problems.push(`${role} ${path}: HTTP ${res?.status()}`);
    if (new URL(page.url()).pathname.startsWith("/login")) problems.push(`${role} ${path}: sent to sign-in`);
    if (await page.getByText(/something went wrong/i).count()) problems.push(`${role} ${path}: error page`);
    if ((await page.getByRole("heading", { level: 1 }).count()) === 0) problems.push(`${role} ${path}: no page heading`);
    if (scan) {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      scanned.pages++;
      for (const v of result.violations.filter((x) => x.impact !== "serious" && x.impact !== "critical")) scanned.minor.add(`${v.impact} ${v.id}`);
      for (const v of result.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
        problems.push(`${role} ${path}: ${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`);
      }
    }
  }
  return problems;
}

test("every role opens every page of its navigation without errors or serious accessibility problems", async ({ page }, info) => {
  test.setTimeout(600_000);
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const scan = info.project.name === "desktop";
  const problems: string[] = [];

  // Control: the scanner must flag a known problem, or a silent scanner would pass every page.
  if (scan) {
    await page.setContent(`<html lang="en"><body><main><h1>Control</h1><img src="x.png"><input type="text"></main></body></html>`);
    const control = await new AxeBuilder({ page }).analyze();
    expect(control.violations.map((v) => v.id)).toEqual(expect.arrayContaining(["image-alt", "label"]));
  }

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  const staff = async (name: string, no: string, email: string, role: "teacher" | "finance") => {
    await page.goto("/school/staff", { waitUntil: "networkidle" });
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add staff member" }) });
    await form.getByLabel("Full name", { exact: true }).fill(name);
    await form.getByLabel("Employee number", { exact: true }).fill(no);
    await form.getByLabel("Email", { exact: true }).fill(email);
    await form.getByLabel("Role", { exact: true }).selectOption(role);
    await form.getByRole("button", { name: "Add staff member" }).click();
    return (await page.getByTestId("one-time-code").innerText()).trim();
  };
  const teacherCode = await staff(`Tara ${tag}`, `RT-${tag}`, `tara-${tag}@roles.demo`, "teacher");
  const financeCode = await staff(`Fiona ${tag}`, `RF-${tag}`, `fiona-${tag}@roles.demo`, "finance");
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Rohan ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(`RA-${tag}`);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const studentCode = (await page.getByTestId("one-time-code").innerText()).trim();
  const username = `${info.project.name === "desktop" ? "gvps" : "srv"}.ra-${tag}`;
  await page.getByLabel("Search name, admission number or sign-in name").fill(`RA-${tag}`);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Rohan ${tag}` }).click();
  await page.getByLabel("Parent's name").fill(`Pooja ${tag}`);
  await page.getByLabel("Parent's email").fill(`pooja-${tag}@roles.demo`);
  await page.getByLabel("Relationship", { exact: true }).first().selectOption("mother");
  await page.getByRole("button", { name: "Add parent" }).click();
  const parentCode = (await page.getByTestId("one-time-code").innerText()).trim();

  problems.push(...(await visitAll(page, "admin", PAGES.admin, scan)));
  await signOut(page);

  for (const [role, code, id, password, home] of [
    ["teacher", teacherCode, `tara-${tag}@roles.demo`, "Tara#Roles2026", /\/school$/],
    ["finance", financeCode, `fiona-${tag}@roles.demo`, "Fiona#Roles2026", /\/school\/fees$/],
    ["student", studentCode, username, "Rohan#Roles2026", /\/student$/],
    ["parent", parentCode, `pooja-${tag}@roles.demo`, "Pooja#Roles2026", /\/parent$/],
  ] as const) {
    await redeem(page, code, password);
    await signIn(page, id, password);
    await expect(page).toHaveURL(home);
    problems.push(...(await visitAll(page, role, [...PAGES[role]], scan)));
    await signOut(page);
  }
  if (scan) console.log(`axe scanned ${scanned.pages} pages; lesser findings: ${[...scanned.minor].join(", ") || "none"}`);
  expect(problems).toEqual([]);
});
