import { expect, test } from "@playwright/test";
import { signIn, signInSuper, signOut } from "./helpers";

/**
 * Phase 15.1: the platform administrator gives a school a plan that ends soon (renewal due) and
 * issues an invoice; the school's principal sees the notice and the plan; recording the payment
 * renews the subscription. The plan includes every module and ends in
 * the future, so the specs that follow are unaffected. Read-only expiry and module refusal are
 * covered by subscriptions.test.ts.
 */
const school = (name: string) => (name === "desktop" ? { name: "Green Valley Public School", admin: "principal@gvps.demo" } : { name: "Sunrise Vidyalaya", admin: "principal@srv.demo" });

function inIndia(days: number): string {
  return new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

test("a plan is assigned, renewal falls due, and paying the invoice renews access", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);

  await signInSuper(page);
  await page.goto("/admin/plans", { waitUntil: "networkidle" });
  await page.getByLabel("Code").fill(`all-${tag}`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create plan" }) });
  await form.getByLabel("Name", { exact: true }).fill(`Everything ${tag}`);
  for (const box of await form.getByRole("checkbox").all()) await box.check();
  await form.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("heading", { name: `Everything ${tag} (all-${tag})` })).toBeVisible();

  await page.goto("/admin", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: s.name }).first().click();
  await expect(page.getByRole("heading", { name: s.name, level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const sub = page.locator("form").filter({ has: page.getByRole("button", { name: "Save subscription" }) });
  await sub.getByLabel("Plan").selectOption({ label: `Everything ${tag}` });
  await sub.getByLabel("Starts on").fill(inIndia(-360));
  await sub.getByLabel("Ends on").fill(inIndia(5));
  if (await sub.getByLabel("Reason for the change").count()) await sub.getByLabel("Reason for the change").fill("End-to-end test");
  await sub.getByRole("button", { name: "Save subscription" }).click();
  await expect(page.getByText("Renewal due", { exact: true }).first()).toBeVisible();

  const inv = page.locator("form").filter({ has: page.getByRole("button", { name: "Issue invoice" }) });
  await inv.getByLabel("Period from").fill(inIndia(6));
  await inv.getByLabel("Period to").fill(inIndia(370));
  await inv.getByLabel("Amount (₹)").fill("45000");
  await inv.getByRole("button", { name: "Issue invoice" }).click();
  await expect(inv.getByRole("status")).toContainText(/Invoice PI-\d{4}-\d{4} issued/);
  const number = ((await inv.getByRole("status").innerText()).match(/PI-\d{4}-\d{4}/) ?? [""])[0];
  await signOut(page);

  // The principal sees that renewal is due.
  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await expect(page.getByRole("status").filter({ hasText: "subscription ends on" })).toBeVisible();
  await page.goto("/school/subscription", { waitUntil: "networkidle" });
  await expect(page.getByText(`Everything ${tag}`)).toBeVisible();
  await expect(page.getByText(`${number} · ₹45,000.00`)).toBeVisible();
  await signOut(page);

  // Payment is recorded and renews the subscription (recording the same reference twice is covered by subscriptions.test.ts).
  await signInSuper(page);
  await page.goto("/admin", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: s.name }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByText(`Record payment for ${number}`).click();
  const pay = page.locator("form").filter({ has: page.getByRole("button", { name: "Record payment" }) }).first();
  await pay.getByLabel("Reference (UTR, cheque no.)").fill(`UTR-${tag}`);
  await pay.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText(`Paid ${inIndia(0)} (UTR-${tag})`)).toBeVisible();
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
});
