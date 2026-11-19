import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Phase 13.3: inventory. Independent of other specs except the demo schools and their admins.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

test("an administrator tracks a laptop by tag and chalk by count; stock never goes below zero", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const employeeNo = `INV-${tag}`;
  const assetTag = `LAP-${tag}`;

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/staff", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Ravi ${tag}`);
  await page.getByLabel("Employee number", { exact: true }).fill(employeeNo);
  await page.getByLabel("Email", { exact: true }).fill(`ravi-${tag}@inventory.demo`);
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByTestId("one-time-code")).toBeVisible();

  await page.goto("/school/inventory", { waitUntil: "networkidle" });
  await page.getByLabel("New location").fill(`Store ${tag}`);
  await page.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: `Store ${tag}` })).toBeVisible();

  // An asset, tracked by tag.
  const newItem = page.locator("form").filter({ has: page.getByRole("button", { name: "Add item" }) });
  await newItem.getByLabel("Name", { exact: true }).fill(`Laptop ${tag}`);
  await newItem.getByLabel("Kind").selectOption("asset");
  await newItem.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { name: `Laptop ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add assets" }) });
  await add.getByLabel("Tags").fill(assetTag);
  await add.getByLabel("Location").selectOption({ label: `Store ${tag}` });
  await add.getByRole("button", { name: "Add assets" }).click();
  await expect(page.getByRole("row").filter({ hasText: assetTag }).getByText("In store")).toBeVisible();

  const alloc = page.locator("form").filter({ has: page.getByRole("button", { name: "Allocate" }) });
  await alloc.getByLabel("Tag").fill(assetTag.toLowerCase());
  await alloc.getByLabel("Employee number").fill(employeeNo);
  await alloc.getByRole("button", { name: "Allocate" }).click();
  await expect(alloc.getByRole("status")).toContainText(`allocated to Ravi ${tag}`);
  await alloc.getByLabel("Tag").fill(assetTag);
  await alloc.getByLabel("Employee number").fill(employeeNo);
  await alloc.getByRole("button", { name: "Allocate" }).click();
  await expect(alloc.getByRole("alert")).toContainText("already allocated");

  const back = page.locator("form").filter({ has: page.getByRole("button", { name: "Take back" }) });
  await back.getByLabel("Tag").fill(assetTag);
  await back.getByLabel("Back to location").selectOption({ label: `Store ${tag}` });
  await back.getByRole("button", { name: "Take back" }).click();
  await expect(back.getByRole("status")).toContainText("back in store");
  await expect(page.getByRole("row").filter({ hasText: "Returned" }).first()).toBeVisible();

  // A consumable, counted.
  await page.goto("/school/inventory", { waitUntil: "networkidle" });
  await newItem.getByLabel("Name", { exact: true }).fill(`Chalk ${tag}`);
  await newItem.getByLabel("Kind").selectOption("consumable");
  await newItem.getByLabel("Unit (consumables)").fill("boxes");
  await newItem.getByLabel("Reorder level (consumables)").fill("5");
  await newItem.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("heading", { name: `Chalk ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const receive = page.locator("form").filter({ has: page.getByRole("button", { name: "Receive" }) });
  await receive.getByLabel("Location").selectOption({ label: `Store ${tag}` });
  await receive.getByLabel("Quantity (boxes)").fill("10");
  await receive.getByRole("button", { name: "Receive" }).click();
  await expect(receive.getByRole("status")).toContainText("Balance there: 10");

  const issue = page.locator("form").filter({ has: page.getByRole("button", { name: "Issue" }) });
  await issue.getByLabel("From location").selectOption({ label: `Store ${tag}` });
  await issue.getByLabel("Quantity (boxes)").fill("12");
  await issue.getByLabel("Purpose (needed without a staff member)").fill("Class 3 board");
  await issue.getByRole("button", { name: "Issue" }).click();
  await expect(issue.getByRole("alert")).toContainText("Only 10 in stock");
  await issue.getByLabel("Quantity (boxes)").fill("7");
  await issue.getByRole("button", { name: "Issue" }).click();
  await expect(issue.getByRole("status")).toContainText("Balance there: 3");
  await expect(page.getByRole("row").filter({ hasText: "Issued -7" })).toBeVisible();

  // Low stock shows on the inventory page.
  await page.goto("/school/inventory?show=low", { waitUntil: "networkidle" });
  await expect(page.getByRole("row").filter({ hasText: `Chalk ${tag}` }).getByText("Low stock")).toBeVisible();
});
