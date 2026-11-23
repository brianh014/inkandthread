import { expect, type Page, test } from "@playwright/test";
import { newStory, showChoicesAgain } from "./support";

const PC_INPUT = /say or do\?$/;
const choiceButtons = (page: Page) => page.getByRole("group", { name: "Choices" }).getByRole("button");
const modeButton = (page: Page) => page.getByRole("button", { name: "Choices", exact: true });

test.afterEach(showChoicesAgain);

test("a new story opens with three Choices, and picking one sends it as the PC's words", async ({ page }) => {
  await newStory(page);
  await expect(choiceButtons(page)).toHaveCount(3);
  // The text box stays, as a fourth box under the Choices.
  await expect(page.getByRole("group", { name: "Choices" }).getByRole("textbox", { name: PC_INPUT })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decide for me" })).toHaveCount(0);
  await expect(modeButton(page)).toHaveAttribute("aria-pressed", "true");

  const picked = (await choiceButtons(page).first().textContent())!;
  await choiceButtons(page).first().click();

  await expect(page.getByTestId("message-narrator")).toHaveCount(2);
  await expect(page.getByTestId("message-player").last()).toContainText(picked);
  await expect(choiceButtons(page)).toHaveCount(3);
});

test("the Choices button hides the Choices for typing, in every story, and shows them again without writing the reply again", async ({ page }) => {
  await newStory(page);
  const textbox = page.getByRole("textbox", { name: PC_INPUT });

  await modeButton(page).click();
  await expect(modeButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(choiceButtons(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decide for me" })).toBeVisible();
  // A Setting, not this story's: the page reloaded keeps them hidden.
  await page.reload();
  await expect(modeButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(textbox).toBeVisible();

  // Written with the reply all along, so they come back with no Regenerate.
  await modeButton(page).click();
  await expect(page.getByRole("dialog", { name: "Write this response with Choices?" })).toHaveCount(0);
  await expect(choiceButtons(page)).toHaveCount(3);
  await expect(textbox).toHaveAttribute("placeholder", "Or write your own…");
  await expect(page.getByTestId("message-narrator")).toHaveCount(1);
});

test("the player can write their own move instead of a Choice, and on a phone the Choices sit in the story", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await newStory(page);
  const story = page.getByRole("region", { name: "Story" });
  await expect(story.getByRole("group", { name: "Choices" }).getByRole("button")).toHaveCount(3);

  await story.getByRole("textbox", { name: PC_INPUT }).fill("I wave to the ferryman.");
  await story.getByRole("textbox", { name: PC_INPUT }).press("Enter");

  await expect(page.getByTestId("message-player").last()).toContainText("I wave to the ferryman.");
  await expect(page.getByTestId("message-narrator")).toHaveCount(2);
  await expect(choiceButtons(page)).toHaveCount(3);
  await expect(story.getByRole("textbox", { name: PC_INPUT })).toHaveValue("");
});
