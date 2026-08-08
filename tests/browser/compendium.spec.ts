import { expect, test } from "@playwright/test";

import { IDS } from "../qa/postgres.mts";

test("@anonymous landing redirects and APIs reject without a session", async ({ page, request }) => {
  await page.goto("/en/compendium");
  await expect(page).toHaveURL(/\/login\?next=%2Fen%2Fcompendium/);
  const response = await request.get("/api/compendium/entries");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Authentication required." });
});

test("@user actual spell filters, deep link, citation preview, and print layout work", async ({ page, request }) => {
  await page.goto("/en/compendium");
  await expect(page.getByRole("heading", { name: "Adventurer's compendium" })).toBeVisible();
  await page.locator('.category-tile[href="/en/compendium/categories/spell"]').click();
  await expect(page).toHaveURL(/\/en\/compendium\/categories\/spell/);
  await page.getByRole("link", { name: "QA Spell 1" }).click();
  await expect(page.getByRole("heading", { name: "QA Spell 1" })).toBeVisible();

  await page.goto("/spells");
  await page.getByLabel("Name or alias").fill("QA Spell 1");
  await page.getByRole("group", { name: "Level" }).getByLabel("1").check();
  await page.getByRole("group", { name: "School" }).getByLabel("Evocation").check();
  await page.getByLabel("Ritual").selectOption("false");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/q=QA(?:\+|%20)Spell(?:\+|%20)1.*level=1.*school=evocation.*ritual=false/);
  await expect(page.locator(".spell-list > li")).toHaveCount(1);
  await page.getByRole("link", { name: /QA Spell 1/ }).click();
  await expect(page).toHaveURL(/\/spells\/qa-spell-1/);
  const preview = page.getByRole("link", { name: "Open PDF preview" });
  const [popup] = await Promise.all([page.waitForEvent("popup"), preview.click()]);
  await popup.waitForLoadState("load");
  await expect(popup).toHaveURL(/\/api\/citations\/preview\?.*page=1/);
  await expect(popup.locator("img")).toBeVisible();
  await popup.close();

  await page.emulateMedia({ media: "print" });
  const printLayout = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector(".desktop-sidebar")!).display,
    back: getComputedStyle(document.querySelector(".spell-back")!).display,
    padding: getComputedStyle(document.querySelector(".app-content")!).padding,
    breakInside: getComputedStyle(document.querySelector(".spell-citations blockquote")!).breakInside,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(printLayout).toEqual({ sidebar: "none", back: "none", padding: "0px", breakInside: "avoid", overflow: 0 });

  expect((await request.get("/api/admin/compendium/entries")).status()).toBe(403);
  expect((await request.get(`/api/admin/compendium/import-runs/${IDS.browserImportRun}`)).status()).toBe(403);
});

test("@user mobile drawer performs a real navigation and restores main focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/compendium");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("@no-access otherwise matching English homebrew corpus is authorization-empty", async ({ page, request }) => {
  const response = await request.get("/api/compendium/entries?edition=5.5e&language=en&category=homebrew");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ entries: [], count: 0 });
  await page.goto("/en/compendium/entries/50000000-0000-4000-8000-000000000003");
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
});

test("@premium premium cannot read another user's personal source", async ({ request }) => {
  expect((await request.get(`/api/sources/${IDS.sources.personal}`)).status()).toBe(404);
  expect((await request.get(`/api/sources/${IDS.sources.premium}`)).status()).toBe(200);
});

test("@owner personal owner reads personal and premium sources", async ({ request }) => {
  expect((await request.get(`/api/sources/${IDS.sources.personal}`)).status()).toBe(200);
  expect((await request.get(`/api/sources/${IDS.sources.premium}`)).status()).toBe(200);
});

test("@admin editor saves a real immutable revision", async ({ page }) => {
  await page.goto("/admin/compendium/entries");
  await expect(page.getByRole("heading", { name: "Structured entry editor" })).toBeVisible();
  await page.getByRole("button", { name: /qa-spell-1/ }).click();
  await expect(page.getByLabel("Title")).toHaveValue("QA Spell 1");
  await page.getByLabel("Title").fill("QA Spell 1 Revised");
  await page.getByLabel("Change reason").fill("Issue 95 browser QA correction");
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: /#2 QA Spell 1 Revised/ })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue("QA Spell 1 Revised");
});

test("@admin review rejection persists a real state transition", async ({ page, request }) => {
  await page.goto(`/admin/compendium/imports/${IDS.browserImportRun}`);
  await expect(page.getByRole("heading", { name: "Open 2024 Rules" })).toBeVisible();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "qa-review-spell" }) });
  await expect(card).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(card.getByText("rejected", { exact: true })).toBeVisible();
  const detail = await request.get(`/api/admin/compendium/import-runs/${IDS.browserImportRun}`);
  expect(detail.ok()).toBeTruthy();
  expect((await detail.json()).candidates[0]).toMatchObject({ decision: "rejected", publicationStatus: "idle" });
  const matching = await request.get("/api/compendium/entries?edition=5.5e&language=en&category=homebrew");
  expect((await matching.json()).count).toBe(2);
});
