import { expect, test } from "@playwright/test";

import { IDS } from "../qa/postgres.mts";

test("@anonymous landing redirects and APIs reject without a session", async ({ page, request }) => {
  for (const path of ["/favicon.ico", "/icon.svg"]) {
    const icon = await request.get(path, { maxRedirects: 0 });
    expect(icon.status(), path).toBe(200);
    expect(icon.headers()["content-type"], path).toMatch(/^image\//);
    expect(icon.headers()["cache-control"], path).toMatch(/(?:public|max-age)/);
    expect((await icon.body()).subarray(0, 256).toString("utf8"), path).toMatch(/<svg|PNG|JFIF/);
  }
  await page.goto("/en/compendium");
  await expect(page).toHaveURL(/\/login\?next=%2Fen%2Fcompendium/);
  const email = page.getByLabel("Email");
  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await expect(email).toHaveCSS("border-color", "rgb(138, 49, 45)");
  const authPalette = await page.evaluate(() => {
    const pageRoot = document.querySelector(".app-parchment")!;
    const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const input = document.querySelector<HTMLInputElement>('#login-email')!;
    return {
      page: getComputedStyle(pageRoot).backgroundColor,
      action: getComputedStyle(button).backgroundColor,
      actionText: getComputedStyle(button).color,
      focus: getComputedStyle(input).borderColor,
    };
  });
  expect(authPalette).toEqual({
    page: "rgb(229, 211, 173)",
    action: "rgb(138, 49, 45)",
    actionText: "rgb(255, 247, 223)",
    focus: "rgb(138, 49, 45)",
  });
  const response = await request.get("/api/compendium/entries");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "Authentication required." });
});

test("@anonymous register uses the parchment action and focus palette", async ({ page }) => {
  await page.goto("/en/compendium");
  await page.goto("/register?next=%2Fen%2Fcompendium");
  const displayName = page.locator("#reg-display-name");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(displayName).toBeFocused();
  await expect(displayName).toHaveCSS("border-color", "rgb(138, 49, 45)");
  const registerPalette = await page.evaluate(() => {
    const pageRoot = document.querySelector(".app-parchment")!;
    const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const input = document.querySelector<HTMLInputElement>("#reg-display-name")!;
    return {
      page: getComputedStyle(pageRoot).backgroundColor,
      action: getComputedStyle(button).backgroundColor,
      actionText: getComputedStyle(button).color,
      focus: getComputedStyle(input).borderColor,
    };
  });
  expect(registerPalette).toEqual({
    page: "rgb(229, 211, 173)",
    action: "rgb(138, 49, 45)",
    actionText: "rgb(255, 247, 223)",
    focus: "rgb(138, 49, 45)",
  });
});

test("@user actual spell filters, deep link, citation preview, and print layout work", async ({ page, request }) => {
  await page.goto("/en/compendium");
  await expect(page.getByRole("heading", { name: "Adventurer's compendium" })).toBeVisible();
  const desktopPalette = await page.evaluate(() => ({
    surface: getComputedStyle(document.querySelector(".sidebar-panel")!).backgroundColor,
    accent: getComputedStyle(document.querySelector(".desktop-sidebar .brand-lockup strong span")!).color,
  }));
  expect(desktopPalette).toEqual({ surface: "rgb(48, 35, 24)", accent: "rgb(217, 138, 128)" });
  await page.locator('.category-tile[href="/en/compendium/categories/spell"]').click();
  await expect(page).toHaveURL(/\/en\/compendium\/categories\/spell/);
  await page.getByRole("link", { name: "QA Spell 1" }).click();
  await expect(page.getByRole("heading", { name: "QA Spell 1" })).toBeVisible();

  await page.goto("/search");
  const searchPalette = await page.getByRole("button", { name: "Search" }).evaluate((button) => ({
    action: getComputedStyle(button).backgroundColor,
    actionText: getComputedStyle(button).color,
  }));
  expect(searchPalette).toEqual({ action: "rgb(138, 49, 45)", actionText: "rgb(229, 211, 173)" });

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
  const previewImage = popup.locator("img");
  await expect(previewImage).toBeVisible();
  const renderedPixels = await previewImage.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let darkPixels = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240) darkPixels += 1;
    }
    return { width: image.naturalWidth, height: image.naturalHeight, darkPixels };
  });
  expect(renderedPixels.width).toBeGreaterThan(100);
  expect(renderedPixels.height).toBeGreaterThan(100);
  expect(renderedPixels.darkPixels).toBeGreaterThan(0);
  await popup.close();

  const pagePreviewUrl = `/api/citations/preview?sourceId=${IDS.sources.open}&fileId=${IDS.files.open}&page=1`;
  const pagePreview = await request.get(pagePreviewUrl);
  expect(pagePreview.status()).toBe(200);
  expect(pagePreview.headers()["content-type"]).toBe("image/png");
  expect(pagePreview.headers()["cache-control"]).toBe("private, no-store");
  expect((await pagePreview.body()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const chunkPreview = await request.get(`/api/citations/preview?chunkId=${IDS.chunks.open}`);
  expect(chunkPreview.status()).toBe(200);
  expect(chunkPreview.headers()["content-type"]).toBe("image/png");
  expect(chunkPreview.headers()["cache-control"]).toBe("private, no-store");
  expect((await chunkPreview.body()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect((await request.get(`${pagePreviewUrl.slice(0, -1)}0`)).status()).toBe(400);
  expect((await request.get(`${pagePreviewUrl.slice(0, -1)}2`)).status()).toBe(404);

  await page.emulateMedia({ media: "print" });
  const printLayout = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector(".desktop-sidebar")!).display,
    back: getComputedStyle(document.querySelector(".spell-back")!).display,
    padding: getComputedStyle(document.querySelector(".app-content")!).padding,
    breakInside: getComputedStyle(document.querySelector(".spell-citations blockquote")!).breakInside,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    pageBackground: getComputedStyle(document.querySelector(".app-content")!).backgroundColor,
    pageText: getComputedStyle(document.querySelector(".app-content")!).color,
  }));
  expect(printLayout).toEqual({
    sidebar: "none",
    back: "none",
    padding: "0px",
    breakInside: "avoid",
    overflow: 0,
    pageBackground: "rgb(255, 255, 255)",
    pageText: "rgb(17, 17, 17)",
  });

  expect((await request.get("/api/admin/compendium/entries")).status()).toBe(403);
  expect((await request.get(`/api/admin/compendium/import-runs/${IDS.browserImportRun}`)).status()).toBe(403);
});

test("@user mobile drawer performs a real navigation and restores main focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/compendium");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
  const drawerPalette = await drawer.evaluate((element) => {
    const close = element.querySelector<HTMLButtonElement>(".close-button")!;
    return {
      surface: getComputedStyle(element.querySelector(".mobile-drawer")!).backgroundColor,
      accent: getComputedStyle(element.querySelector(".brand-lockup strong span")!).color,
      focus: getComputedStyle(close).outlineColor,
    };
  });
  expect(drawerPalette).toEqual({
    surface: "rgb(48, 35, 24)",
    accent: "rgb(217, 138, 128)",
    focus: "rgb(240, 202, 120)",
  });
  await drawer.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("@user Classes navigation renders classes, subclasses, features, and source metadata", async ({ page }) => {
  await page.goto("/en/compendium");
  await page.getByRole("link", { name: "Classes", exact: true }).click();
  await expect(page).toHaveURL(/\/classes$/);
  await expect(page.getByRole("heading", { name: "Classes and subclasses" })).toBeVisible();
  await expect(page.locator(".option-list > li")).toHaveCount(3);
  await page.getByRole("link", { name: /QA Fighter/ }).click();
  await expect(page.getByRole("heading", { name: "QA Fighter" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Second Wind" })).toBeVisible();
  await expect(page.getByRole("link", { name: /QA100/ })).toBeVisible();
});

test("@user Species navigation renders historical species and exact variant detail links", async ({ page }) => {
  await page.goto("/en/compendium");
  await page.getByRole("link", { name: "Species", exact: true }).click();
  await expect(page).toHaveURL(/\/species$/);
  await expect(page.getByRole("heading", { name: "Species and variants" })).toBeVisible();
  await expect(page.locator(".option-list > li")).toHaveCount(3);
  await page.getByRole("link", { name: /QA Fleet Human/ }).click();
  await expect(page.getByRole("heading", { name: "QA Fleet Human" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
  const parent = page.getByRole("link", { name: "species-human" });
  await expect(parent).toHaveAttribute("href", new RegExp(`^/species/species-human\\?sourceId=${IDS.sources.open}&revisionId=rev-${"1".repeat(64)}$`));
  await parent.click();
  await expect(page.getByRole("heading", { name: "QA Human" })).toBeVisible();
});

test("@no-access otherwise matching English homebrew corpus is authorization-empty", async ({ page, request }) => {
  const response = await request.get("/api/compendium/entries?edition=5.5e&language=en&category=homebrew");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ entries: [], count: 0 });
  await page.goto("/en/compendium/entries/50000000-0000-4000-8000-000000000003");
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  await page.goto("/classes?category=homebrew");
  await expect(page.getByRole("heading", { name: "Classes and subclasses" })).toBeVisible();
  await expect(page.getByText("No accessible options found.")).toBeVisible();
  await page.goto("/species?category=homebrew");
  await expect(page.getByRole("heading", { name: "Species and variants" })).toBeVisible();
  await expect(page.getByText("No accessible options found.")).toBeVisible();
  const inaccessible = await request.get(`/api/citations/preview?sourceId=${IDS.sources.personal}&fileId=${IDS.files.personal}&page=1`);
  const absent = await request.get("/api/citations/preview?sourceId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&fileId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&page=1");
  expect(inaccessible.status()).toBe(404);
  expect(await inaccessible.json()).toEqual(await absent.json());
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

const advancedUploadLabels = [
  "Publication code",
  "Publication title",
  "Publisher",
  "Release year",
  "Revision / reprint",
  "External origin URL",
  "External origin ID",
  "Attribution",
  "Source priority",
  "Canonical book ID",
  "License",
];

test("@admin ordinary upload has a streamlined keyboard flow and minimal payload", async ({ page }) => {
  let submittedFields: string[] = [];
  await page.route("**/api/admin/ingestion/upload", async (route) => {
    const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
    submittedFields = [...body.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((match) => match[1]);
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ sourceId: "source-1", jobId: "job-1" }) });
  });

  await page.goto("/admin/ingestion");
  for (const label of advancedUploadLabels) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await page.locator("#pdf-file-input").setInputFiles({ name: "rules.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  const title = page.getByLabel("Title *");
  await title.fill("  QA Rules  ");
  await title.focus();
  for (let index = 0; index < 6; index += 1) await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Upload and process" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => submittedFields).toEqual([
    "file",
    "title",
    "category",
    "edition",
    "language",
    "accessTier",
    "canonicalSourceId",
  ]);
});

test("@admin ordinary upload omits advanced controls on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/ingestion");
  for (const label of advancedUploadLabels) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Title *")).toBeVisible();
  await expect(page.getByText("Canonical source ID", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("@admin review rejection persists a real state transition", async ({ page, request }) => {
  await page.goto(`/admin/compendium/imports/${IDS.browserImportRun}`);
  await expect(page.getByRole("heading", { name: "Open 2024 Rules" })).toBeVisible();
  const runStatus = page.locator("header").getByText("succeeded", { exact: true });
  const approve = page.locator(".sticky").getByRole("button", { name: "Approve" });
  const adminPalette = {
    status: await runStatus.evaluate((element) => getComputedStyle(element).color),
    ...await approve.evaluate((element) => ({
      action: getComputedStyle(element).backgroundColor,
      actionText: getComputedStyle(element).color,
    })),
  };
  expect(adminPalette).toEqual({
    status: "rgb(45, 89, 56)",
    action: "rgb(138, 49, 45)",
    actionText: "rgb(255, 247, 223)",
  });
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
