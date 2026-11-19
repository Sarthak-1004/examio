import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phases 13.4-13.5: transport, the operations dashboard and CSV downloads. Runs after
 * setup.spec.ts (files run in name order with one worker): "Class 1 A" exists in each project's
 * demo school.
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

async function admit(page: Page, name: string, admission: string): Promise<string> {
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(name);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  return (await page.getByTestId("one-time-code").innerText()).trim();
}

test("a route takes students up to its vehicle's seats; the student sees the route; reports download", async ({ page, request }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const first = `TR-${tag}`;
  const second = `TS-${tag}`;
  const reg = `KA01 ${tag.toUpperCase()}`;

  // Downloads need a signed-in administrator.
  expect((await request.get("/school/transport/export")).status()).toBe(403);

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await expect(page.getByRole("heading", { name: "School operations" })).toBeVisible();
  const code = await admit(page, `Nila ${tag}`, first);
  await admit(page, `Omar ${tag}`, second);

  await page.goto("/school/transport", { waitUntil: "networkidle" });
  const vehicle = page.locator("form").filter({ has: page.getByRole("button", { name: "Add vehicle" }) });
  await vehicle.getByLabel("Registration number").fill(reg);
  await vehicle.getByLabel("Seats for students").fill("1");
  await vehicle.getByRole("button", { name: "Add vehicle" }).click();
  await expect(vehicle.getByRole("status")).toContainText("Vehicle added.");

  const route = page.locator("form").filter({ has: page.getByRole("button", { name: "Add route" }) });
  await route.getByLabel("Route name").fill(`East ${tag}`);
  await route.getByLabel("Vehicle (optional)").selectOption({ label: `${reg} (1 seats)` });
  await route.getByRole("button", { name: "Add route" }).click();
  await expect(page.getByRole("heading", { name: `East ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const stop = page.locator("form").filter({ has: page.getByRole("button", { name: "Add stop" }) });
  await stop.getByLabel("Position").fill("1");
  await stop.getByLabel("Stop name").fill("Clock tower");
  await stop.getByLabel("Pickup time (optional)").fill("07:15");
  await stop.getByRole("button", { name: "Add stop" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Clock tower" })).toBeVisible();

  const assign = page.locator("form").filter({ has: page.getByRole("button", { name: "Assign" }) });
  await assign.getByLabel("Admission number").fill(first);
  await assign.getByLabel("Stop").selectOption({ label: "1. Clock tower" });
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(assign.getByRole("status")).toContainText(`Nila ${tag} assigned.`);
  await assign.getByLabel("Admission number").fill(second);
  await assign.getByLabel("Stop").selectOption({ label: "1. Clock tower" });
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(assign.getByRole("alert")).toContainText("more students on the route than the vehicle has seats");

  const csv = await page.request.get(`/school/transport/export`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(`East ${tag},${reg},1,Clock tower,07:15,,${first},Nila ${tag}`);
  for (const url of ["/school/admissions/export", "/school/library/export?show=overdue", "/school/inventory/export?kind=stock"]) {
    expect((await page.request.get(url)).status()).toBe(200);
  }
  await signOut(page);

  await redeem(page, code, "Nila#Ride2026");
  await signIn(page, `${s.code}.${first.toLowerCase()}`, "Nila#Ride2026");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/transport");
  await expect(page.getByText(`East ${tag}`)).toBeVisible();
  await expect(page.getByText("Clock tower")).toBeVisible();
  await expect(page.getByText("07:15")).toBeVisible();
  // A student cannot download school reports.
  expect((await page.request.get("/school/transport/export")).status()).toBe(403);
});
