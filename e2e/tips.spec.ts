import { expect, test } from "@playwright/test";
import { newStory, sendTurn } from "./support";

// The fake server starts with the tips seen, so no other test meets them. These show them again, and leave them seen.
const showAgain = (request: import("@playwright/test").APIRequestContext) => request.post("/settings/tips", { data: { how: "again" } });
test.afterEach(({ request }) => request.post("/settings/tips", { data: { how: "finished" } }));

test("the first-time tips walk the tools by the box and under the response, once", async ({ page, request }) => {
  await showAgain(request);
  await newStory(page);

  const tip = page.getByRole("dialog", { name: /^Tip: / });
  const seen: string[] = [];
  for (;;) {
    await expect(tip).toBeVisible();
    seen.push((await tip.getAttribute("aria-label"))!.replace("Tip: ", ""));
    const done = page.getByRole("button", { name: "Done" });
    // Enter presses Next, which has focus.
    const last = await done.isVisible();
    await page.keyboard.press("Enter");
    if (last) break;
  }
  expect(seen).toEqual([
    "Draw a picture",
    "Ask the Narrator",
    "Tell Narrator what to change",
    "Choices",
    "Decide for me",
    "Continue",
    "Send",
    "Tools under a response",
  ]);
  // Each tip names a button that is really there, so a renamed tool fails here.
  for (const name of seen.slice(0, -1)) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(tip).toBeHidden();
  await expect(page.getByRole("textbox", { name: /say or do\?$/ })).toBeFocused();

  await page.reload();
  await expect(page.getByTestId("message-narrator")).toHaveCount(1);
  await expect(tip).toBeHidden();
});

test("Escape skips the tips, and a move ends them", async ({ page, request }) => {
  await showAgain(request);
  await newStory(page);
  const tip = page.getByRole("dialog", { name: /^Tip: / });
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();

  await showAgain(request);
  await page.reload();
  await expect(tip).toBeVisible();
  await sendTurn(page, "I look around.");
  await expect(tip).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("message-narrator")).toHaveCount(2);
  await expect(tip).toBeHidden();
});
