import { expect, test } from "@playwright/test";
import { signIn, signInSuper } from "./helpers";

/** Phase 2, task 02.1: keyboard behaviour of the shared shell, and list search/pagination. */

test("the first Tab stop skips straight to the main content", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard-first check on desktop");
  await signIn(page, "principal@gvps.demo", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("the mobile menu traps focus, closes on Escape and returns focus", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the drawer exists only on small screens");
  await signIn(page, "principal@gvps.demo", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  const open = page.getByRole("button", { name: "Open menu" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  // Focus moved into the drawer and stays there while tabbing.
  for (let i = 0; i < 20; i++) {
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute("aria-expanded", "false");

  // The close button works too, and navigating closes the drawer.
  await open.click();
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(dialog).toBeHidden();
  await open.click();
  await dialog.getByRole("link", { name: "Dashboard" }).click();
  await expect(dialog).toBeHidden();
});

test("the school list searches, filters and paginates through the URL", async ({ page }) => {
  await signInSuper(page);
  await expect(page.getByRole("table", { name: "Schools" })).toBeVisible();

  await page.getByLabel("Search by name or code").fill("srv");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/\/admin\?q=srv(&|$)/);
  const rows = page.getByRole("table", { name: "Schools" }).getByRole("row");
  await expect(rows).toHaveCount(2); // header + Sunrise Vidyalaya
  await expect(page.getByRole("rowheader", { name: "Sunrise Vidyalaya" })).toBeVisible();

  await page.getByLabel("Search by name or code").fill("no-such-school");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("No schools match")).toBeVisible();
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/admin$/);

  await page.getByLabel("Status").selectOption("suspended");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/status=suspended/);
  await expect(page.getByText("No schools match")).toBeVisible();

  // Out-of-range and malformed parameters fall back safely instead of failing.
  await page.goto("/admin?page=999&size=7&q=" + "x".repeat(300));
  await expect(page.getByRole("heading", { name: "Schools" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pagination" })).toBeVisible();
});

test("an unknown page shows a not-found message without details", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/admin/schools/00000000-0000-4000-8000-000000000000");
  // Signed out: sent to sign-in rather than told whether the school exists.
  await expect(page).toHaveURL(/\/login$/);
});
