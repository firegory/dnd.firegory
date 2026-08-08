import { expect, test } from "@playwright/test";

import { IDS } from "../qa/postgres.mts";

test.describe("anonymous boundaries", () => {
  test("@anonymous landing redirects and APIs reject without a session", async ({ page, request }) => {
    await page.goto("/en/compendium");
    await expect(page).toHaveURL(/\/login\?next=%2Fen%2Fcompendium/);
    const response = await request.get("/api/compendium/entries");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });
});

test.describe("authenticated compendium", () => {
  test("@user landing, filters, category navigation, deep links, citations, mobile, and print", async ({ page, request }) => {
    await page.goto("/en/compendium");
    await expect(page.getByRole("heading", { name: "Adventurer's compendium" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Spells/ })).toBeVisible();

    const filtered = await request.get("/api/compendium/entries?edition=5e&language=en");
    expect(filtered.ok()).toBeTruthy();
    expect((await filtered.json()).entries.map((entry: { canonicalKey: string }) => entry.canonicalKey)).toEqual(["qa-spell-5"]);
    const protectedResponse = await request.get(`/api/sources/${IDS.sources.premium}`);
    expect(protectedResponse.status()).toBe(404);

    await page.getByRole("link", { name: /Spells/ }).click();
    await expect(page).toHaveURL(/\/en\/compendium\/categories\/spell/);
    await page.getByRole("link", { name: "QA Spell 1" }).click();
    await expect(page).toHaveURL(/\/en\/compendium\/entries\/50000000-0000-4000-8000-000000000001/);
    await expect(page.getByRole("heading", { name: "QA Spell 1" })).toBeVisible();
    await expect(page.getByText("Evidence quote for Open 2024 Rules")).toBeVisible();
    await expect(page.getByRole("link", { name: "Citation preview" })).toHaveAttribute("href", /sourceId=.*page=12/);

    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("article.entry-document")).toBeVisible();
    await expect(page.getByText("Printable second paragraph.")).toBeVisible();
  });

  test("@user a valid user with no selected corpus sees the explicit empty state", async ({ page }) => {
    await page.goto("/ru/compendium");
    await expect(page.getByText("В вашей роли пока нет доступных материалов этой редакции.")).toBeVisible();
  });
});

test("@premium premium cannot read another user's personal source", async ({ request }) => {
  const personal = await request.get(`/api/sources/${IDS.sources.personal}`);
  expect(personal.status()).toBe(404);
  expect((await request.get(`/api/sources/${IDS.sources.premium}`)).status()).toBe(200);
});

test("@owner personal owner reads personal and premium sources", async ({ request }) => {
  expect((await request.get(`/api/sources/${IDS.sources.personal}`)).status()).toBe(200);
  expect((await request.get(`/api/sources/${IDS.sources.premium}`)).status()).toBe(200);
});

test.describe("admin workflows", () => {
  test("@admin editor loads live entries and evidence controls", async ({ page }) => {
    await page.goto("/admin/compendium/entries");
    await expect(page.getByRole("heading", { name: "Structured entry editor" })).toBeVisible();
    await expect(page.getByRole("button", { name: /qa-spell-1/ })).toBeVisible();
    await page.getByRole("button", { name: /qa-spell-1/ }).click();
    await expect(page.getByLabel("Title")).toHaveValue("QA Spell 1");
    await expect(page.getByText("Evidence quote for Open 2024 Rules")).toBeVisible();
  });

  test("@admin review page loads persisted candidate state and filters", async ({ page }) => {
    await page.goto(`/admin/compendium/imports/${IDS.browserImportRun}`);
    await expect(page.getByRole("heading", { name: "Open 2024 Rules" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "qa-review-spell" })).toBeVisible();
    await page.getByLabel(/Candidate filter/i).selectOption("new");
    await expect(page.getByRole("heading", { name: "qa-review-spell" })).toBeVisible();
  });
});
