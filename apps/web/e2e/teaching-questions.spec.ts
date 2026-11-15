import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Phase 9: curriculum and question bank. Runs after setup.spec.ts (files run in name order with
 * one worker): the subject "Mathematics" exists in each project's demo school.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

test("an admin builds a chapter, writes and publishes a question, and editing it creates a new version", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);

  // Chapter and topic.
  await page.goto("/school/questions/curriculum", { waitUntil: "networkidle" });
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByRole("button", { name: "Show" }).click();
  await page.getByLabel("Chapter name").fill(`Numbers ${tag}`);
  await page.getByRole("button", { name: "Add chapter" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chapter added." })).toBeVisible();
  await page.getByLabel(`New topic in Numbers ${tag}`).fill("Place value");
  await page.getByRole("button", { name: "Add topic" }).first().click();
  await expect(page.getByText("Place value").first()).toBeVisible();

  // A single-choice question.
  await page.goto("/school/questions/new", { waitUntil: "networkidle" });
  await page.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await page.getByRole("button", { name: "Change subject" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Chapter or topic").selectOption({ label: `Numbers ${tag} › Place value` });
  await page.getByLabel("Question", { exact: true }).fill(`What is the place value of 5 in 352? (${tag})`);
  await page.getByLabel("Option A", { exact: true }).fill("5");
  await page.getByLabel("Option B", { exact: true }).fill("50");
  await page.getByLabel("Option C", { exact: true }).fill("500");
  await page.getByLabel("Option B is correct").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Question saved.")).toBeVisible();
  await expect(page.getByText("Answer: B. 50")).toBeVisible();

  // Publish, then edit: the edit becomes version 2 and version 1 stays published.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Publish version 1" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Question", { exact: true }).fill(`Place value of 5 in 352? (${tag})`);
  await page.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as version 2" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
  await expect(page.getByText(`What is the place value of 5 in 352? (${tag})`)).toBeVisible();

  // The bank lists it; an import adds another question.
  await page.goto(`/school/questions?q=${encodeURIComponent(tag)}`);
  await expect(page.getByRole("link", { name: new RegExp(`Place value of 5 in 352\\? \\(${tag}\\)`) })).toBeVisible();
  await page.goto("/school/questions/import", { waitUntil: "networkidle" });
  await page.getByLabel("Or paste CSV").fill(`subject,chapter,topic,type,marks,question,answer\nMathematics,Numbers ${tag},Place value,tf,1,10 tens make a hundred (${tag}),true`);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText("1 ready, 0 with errors")).toBeVisible();
  await page.getByRole("button", { name: "Import 1 question(s)" }).click();
  await expect(page.getByRole("heading", { name: "Imported 1 question(s)" })).toBeVisible();
});
