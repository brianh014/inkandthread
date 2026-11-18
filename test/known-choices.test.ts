import { expect, test } from "bun:test";
import { join } from "node:path";
import { knownChoices, unknownWords } from "../src/known-choices";
import { settingsStore } from "../src/settings-store";
import { openingState, type State } from "../src/state-applier";
import { scriptedTextProvider, tempFolder } from "./support";

const state: State = {
  ...openingState,
  npcs: [{ name: "Ossery", appearance: "a thin man" }],
  worldBible: [
    { title: "The old hut", keywords: ["old hut", "drums", "Free Wells"], content: "Fuel drums are buried at the old hut.", alwaysOn: false },
    { title: "The road", keywords: ["salt road"], content: "The road.", alwaysOn: true },
  ],
  pcKnown: { facts: ["Jory works the lead strings."], npcs: [] },
};

test("a Choice naming someone or a Lore keyword the player has never read of is caught, and nothing else", () => {
  const choices = ["Ask Tamsin about the old hut.", "Tell Jory that Ossery paid him.", "Ride on and count the drums."];
  // A lone common keyword, such as "drums", is too likely in an honest Choice to count.
  expect(unknownWords(choices, state, "Tamsin rides ahead.")).toEqual([["old hut"], ["Ossery"], []]);
  // Once the player has read of it, it's theirs to ask about.
  expect(unknownWords(choices, state, "Jory mumbles about the old hut and a well-keeper called Ossery.")).toEqual([[], [], []]);
});

test("a Choice built on what the PC hasn't learned is written again by the reviewer, and the others are kept", async () => {
  const reviewer = scriptedTextProvider(
    JSON.stringify({ choices: ["Ask Tamsin about the old hut.", "Ask Jory what scares him.", "Ride on."] }),
    JSON.stringify({ choices: ["Ask Tamsin what she carries.", "Ask Jory what scares him.", "Ride on."] }),
  );
  const folder = tempFolder();
  const settings = settingsStore(join(folder.path, "settings.json"));
  const choices = ["Ask Tamsin about the old hut.", "Ask Jory what scares him.", "Ride on."];

  const offered = await knownChoices(
    { provider: reviewer.textProvider, settings, input: "" },
    choices,
    state,
    "Tamsin rides ahead.",
    "Jory looks away.",
    new AbortController().signal,
  );

  // The first rewrite still named the old hut, so it was asked again.
  expect(offered).toEqual(["Ask Tamsin what she carries.", "Ask Jory what scares him.", "Ride on."]);
  expect(reviewer.prompts).toHaveLength(2);
  folder.remove();
});

test("Choices with nothing unknown cost no call", async () => {
  const reviewer = scriptedTextProvider();
  const folder = tempFolder();
  const settings = settingsStore(join(folder.path, "settings.json"));
  const choices = ["Ask Jory what scares him.", "Ride on.", "Wait."];

  expect(await knownChoices({ provider: reviewer.textProvider, settings, input: "" }, choices, state, "", "", new AbortController().signal)).toBe(choices);
  expect(reviewer.prompts).toHaveLength(0);
  folder.remove();
});
