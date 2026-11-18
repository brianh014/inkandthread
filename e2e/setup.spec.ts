import { expect, test } from "@playwright/test";

test("until the Narrator is set up, the Menu offers Setup, which walks the settings a page at a time and brings back the usual Menu", async ({
  page,
  request,
}) => {
  // A first --fake run saves a text model, so take it away to look like a first launch.
  await request.patch("/settings", { data: { textModel: "" } });
  await page.goto("/");
  const menu = page.getByRole("navigation", { name: "Main Menu" });
  await expect(menu.getByRole("link", { name: "Setup NovelForge" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "New Story" })).toHaveCount(0);
  await expect(menu.getByRole("link", { name: "Load Story" })).toHaveCount(0);

  await menu.getByRole("link", { name: "Setup NovelForge" }).click();
  await expect(page.getByText("Prologue · i", { exact: true })).toBeVisible();
  const next = page.getByRole("button", { name: "Next" });
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.getByRole("heading", { name: "The storyteller" })).toBeVisible();
  await next.click();

  // No model, no going on: play needs one.
  await expect(page.getByRole("heading", { name: "Its model" })).toBeVisible();
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("textbox", { name: "Text model" }).fill("fake-narrator");
  await next.click();

  for (const later of ["A second reader", "A careful eye", "Pictures", "Reading"]) {
    await expect(page.getByRole("heading", { name: later })).toBeVisible();
    await next.click();
  }
  await expect(page.getByRole("heading", { name: "Ready" })).toBeVisible();
  await expect(page.getByText("fake-narrator")).toBeVisible();
  await page.getByRole("link", { name: "Back to the Menu" }).click();
  await expect(menu.getByRole("link", { name: "New Story" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Setup NovelForge" })).toHaveCount(0);

  // Settings brings Setup back, showing what was chosen.
  await page.goto("/#/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Guided setup" }).click();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "iii. Its model", exact: false }).click();
  await expect(page.getByRole("textbox", { name: "Text model" })).toHaveValue("fake-narrator");
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "Ready", exact: false }).click();
  await page.getByRole("link", { name: "Begin a New Story" }).click();
  await expect(page).toHaveURL(/#\/new/);
});
