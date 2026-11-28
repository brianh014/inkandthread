import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PHONE_PORT } from "../playwright.config";
import { newStory, sendTurn } from "./support";

/** The phone app: a static site whose server runs in the page's worker (ADR 0006), played on the fake Narrator. */
test.use({ baseURL: `http://localhost:${PHONE_PORT}`, viewport: { width: 390, height: 844 } });

test("a story plays in the phone app, keeps across a reload, and exports and imports", async ({ page }) => {
  test.setTimeout(90_000);
  await newStory(page);
  await sendTurn(page, "I look around the quay.");
  await expect(page.getByTestId("message-narrator")).toHaveCount(2);

  // Pictures load by <img src>, which only the service worker sends on to the server worker.
  await expect
    .poll(() => page.locator("img[src^='/saves/']").evaluateAll((pictures) => pictures.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length))
    .toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByTestId("message-narrator")).toHaveCount(2);

  // Export is a download link, a request with no page of its own, which the service worker must still answer.
  await page.goto("/#/load");
  const [exported] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("link", { name: /^Export / })
      .first()
      .click(),
  ]);
  const bytes = readFileSync((await exported.path())!);
  expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe("SQLite format 3");

  await page.locator("input[type=file]").setInputFiles({ name: "story.sqlite", mimeType: "application/octet-stream", buffer: bytes });
  await expect(page.getByText(/Imported story\.sqlite/)).toBeVisible();
  await expect(page.getByRole("link", { name: /^Export / })).toHaveCount(2);
});

test("the phone app's log can be saved", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  const log = await page.evaluate(async () => (await fetch("/phone/log")).text());
  expect(log).toContain("Browser storage opened");
  expect(log).toContain("Phone server started");
});

test("the phone app can be installed, and opens with no connection once it has been", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>("link[rel=manifest]")!.href)).json());
  expect(manifest).toMatchObject({ name: "Ink & Thread", display: "standalone", start_url: "/" });
  expect(await page.evaluate(async () => (await (await fetch("/settings")).json()).hostedOnly)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  await context.setOffline(false);
});

test("a move cut off when the app stops comes back unsent, never sent again by itself", async ({ page }) => {
  test.setTimeout(90_000);
  await newStory(page);
  const box = page.getByRole("textbox", { name: /say or do\?$/ });
  await box.fill("I climb the bell tower.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  // Reloading ends the page's server worker, and the Turn with it, as a phone does when it stops the app.
  await page.reload();
  await expect(page.getByText(/stopped before your move was written/)).toBeVisible();
  await expect(box).toHaveValue("I climb the bell tower.");
  await expect(page.getByTestId("message-player")).toHaveCount(0);
});

test("the Menu suggests installing the app until the note is closed", async ({ page }) => {
  await page.goto("/");
  const note = page.getByText(/Add Ink & Thread to your Home Screen/);
  await expect(note).toBeVisible();
  await page.getByRole("button", { name: "Close the note on installing" }).click();
  await page.reload();
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  await expect(note).toBeHidden();
});

test("a new build of the phone app waits for the player, then takes over on Reload to update", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  const scriptOf = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL);
  const before = await page.evaluate(async () => (await caches.keys()).join());
  expect((await request.post("/__rebuild")).status()).toBe(204);
  // The app checks hourly; here, at once.
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await page.getByRole("button", { name: "Reload to update" }).click({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "New Story" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).join())).not.toBe(before);
  expect(await scriptOf()).toContain("/sw.js");
  await expect(page.getByRole("button", { name: "Reload to update" })).toBeHidden();
});
