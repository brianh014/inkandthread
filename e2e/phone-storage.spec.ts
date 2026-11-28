import { expect, test } from "@playwright/test";
import { PHONE_PARITY_PORT } from "../playwright.config";

/**
 * The phone build runs the server's own Save code on stand-ins for bun:sqlite and node:fs (ADR: one server, two hosts).
 * The same run through the Saves, on Bun's SQLite and in Chromium's storage, must come out the same.
 */
test("Saves behave the same in the phone build's storage as on the desktop", async ({ page, request }) => {
  const at = `http://localhost:${PHONE_PARITY_PORT}`;
  const desktop = await (await request.get(`${at}/desktop.json`)).json();
  await page.goto(`${at}/`);
  const phone = await page.evaluate(() => (window as unknown as { parity: Promise<{ result?: unknown; error?: string }> }).parity);
  expect(phone.error).toBeUndefined();
  expect(phone.result).toEqual(desktop);
});

test("only one page has the Saves open, a second is told why, and they free up when the first page goes", async ({ page }) => {
  await page.goto(`http://localhost:${PHONE_PARITY_PORT}/`);
  const said = await page.evaluate(async () => {
    const opening = () =>
      new Promise<string>((done) => {
        const worker = new Worker("/lock-worker.js", { type: "module" });
        worker.onmessage = ({ data }) => done(data);
      });
    const parity = window as unknown as { parity: Promise<unknown>; parityWorker: Worker };
    // The parity run holds the Saves from its start until its worker ends, as a page's server worker would.
    await parity.parity;
    const whileHeld = await opening();
    parity.parityWorker.terminate();
    return { whileHeld, afterwards: await opening() };
  });
  expect(said).toEqual({ whileHeld: "open elsewhere", afterwards: "opened" });
});
