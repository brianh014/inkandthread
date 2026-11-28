import { expect, type Page, test } from "@playwright/test";

/** Fills the form and asks for the world, with the page unable to hear how its build goes until `hear`. */
async function generateUnheard(page: Page) {
  let heard = false;
  const builds: string[] = [];
  await page.route("**/worlds/*/builds/*", (route) => (heard || route.request().method() === "DELETE" ? route.continue() : route.abort()));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/worlds") builds.push(request.postDataJSON().build);
  });
  await page.goto("/#/new");
  await page.getByRole("button", { name: "Pick for me" }).click();
  await page.getByRole("dialog", { name: "Pick for me?" }).getByRole("button", { name: "Pick for me" }).click();
  await expect(page.getByLabel("What is your story called?")).not.toHaveValue("");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Generate the world" }).click();
  await expect(page.getByText("The Narrator is building the world.", { exact: false })).toBeVisible();
  await expect.poll(() => builds.length).toBe(1);
  return { builds, hear: () => (heard = true) };
}

test("a page reloaded while its world is built picks up that same build, and can begin it", async ({ page }) => {
  const { builds, hear } = await generateUnheard(page);

  await page.reload();
  await expect(page.getByText("The Narrator is building the world.", { exact: false })).toBeVisible();
  hear();

  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page).toHaveURL(/#\/play\//);
  await expect(page.getByTestId("message-narrator")).toHaveCount(1);
  expect(builds).toHaveLength(1);
});

test("a build cancelled is told to the server, and the form is back at once with no build to pick up", async ({ page }) => {
  await generateUnheard(page);

  const told = page.waitForRequest((request) => request.method() === "DELETE" && request.url().includes("/builds/"));
  await page.getByRole("button", { name: "Cancel" }).click();
  await told;
  await expect(page.getByRole("button", { name: "Generate the world" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Generate the world" })).toBeVisible();
});

test("with pictures off, there is no Art step: the form writes the world itself, and the world shows no art", async ({ page }) => {
  // Settings as the server gives them, with pictures turned off.
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), imagesEnabled: false } });
  });
  await page.goto("/#/new");
  await expect(page.getByRole("navigation", { name: "Steps" })).not.toContainText("Art");
  await page.getByRole("button", { name: "Pick for me" }).click();
  await page.getByRole("dialog", { name: "Pick for me?" }).getByRole("button", { name: "Pick for me" }).click();
  await expect(page.getByLabel("What is your story called?")).not.toHaveValue("");

  await page.getByRole("button", { name: "Generate the world" }).click();
  await expect(page.getByRole("button", { name: "Begin" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Art" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Steps" })).toContainText("II. Your World");
  await expect(page.getByText("Changing a picture")).toHaveCount(0);

  // Going back promises no pictures either.
  await page.getByRole("button", { name: "Back" }).click();
  const leave = page.getByRole("dialog", { name: "Go back and discard this world?" });
  await expect(leave).toBeVisible();
  await expect(leave).not.toContainText("picture");
});
