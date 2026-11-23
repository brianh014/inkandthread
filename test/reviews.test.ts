import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { reviewerSettings, settingsStore } from "../src/settings-store";
import { openingState } from "../src/state-applier";
import { changeWorld, generateWorld } from "../src/world-creation";
import { logOf, scriptedTextProvider, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
beforeEach(() => {
  folder = tempFolder();
});
afterEach(() => folder.remove());

// With a model, as a reviewer without one isn't asked.
const settings = () => {
  const store = settingsStore(join(folder.path, "settings.json"));
  store.update({ textModel: "narrator/model" });
  return store;
};
const signal = () => new AbortController().signal;
const lore = (title: string) => ({ title, keywords: ["one", "two", "three"], content: `All about ${title}.` });
const WORLD = {
  world_overview: "A drowned city.",
  lore_entries: [lore("The Mayor"), lore("The Tide")],
  world_rules: ["No magic."],
  plot_threads: ["The bees are spies.", "The tide is rising."],
  calendar: "Days by tides.",
  start_date: "First Tide",
  start_time_of_day: "dusk",
  naming: "Names are short and plain.",
};
const NO_EDITS = { world_overview: null, lore_entries: [], world_rules: [], plot_threads: [], calendar: null, start: null };
const CHOICES = { title: "Salt", theme: "Fantasy", worldBrief: "A drowned city", startingHook: "" };
const PC = { pc: { name: "Ash" }, inventory: "" };
const SPARKS = { pressure: "a truce about to break", constraint: "a curfew everyone keeps", secret: "a record quietly changed", nameLetters: "B, M, T" };

const build = (world: string, ...reviews: (string | Error)[]) => {
  const narrator = scriptedTextProvider(world);
  const reviewer = scriptedTextProvider(...reviews);
  const made = generateWorld(
    { textProvider: narrator.textProvider, reviewProvider: reviewer.textProvider, settings: settings() },
    CHOICES,
    PC,
    SPARKS,
    signal(),
  );
  return { made, reviewer };
};

test("the World review's edits are made, each with its fault counted in the log, and the choices and world reach it", async () => {
  const review = {
    ...NO_EDITS,
    plot_threads: [{ fault: "thin_story", old: "The bees are spies.", new: "The mayor's bees spy for the drowned queen." }],
    lore_entries: [{ fault: "plot_hole", ...lore("The Queen") }],
  };
  const { made, reviewer } = build(JSON.stringify(WORLD), JSON.stringify(review));
  let result: Awaited<typeof made> | undefined;
  const log = await logOf(async () => (result = await made));
  expect(result!.world.plotThreads).toEqual(["The mayor's bees spy for the drowned queen.", "The tide is rising."]);
  expect(result!.world.worldBible.map(({ title }) => title)).toEqual(["The Mayor", "The Tide", "The Queen", "Calendar", "Naming"]);
  expect(log).toContain("World reviewed");
  expect(log).toContain('"thin_story":1');
  expect(log).not.toContain("drowned queen");
  const sent = reviewer.prompts[0]!.at(-1)!.content;
  expect(JSON.parse(sent)).toMatchObject({ choices: { title: "Salt", world_brief: "A drowned city" }, world: WORLD });
});

test("a World review with no edits keeps the world as written", async () => {
  const { made } = build(JSON.stringify(WORLD), JSON.stringify(NO_EDITS));
  const { overview, world } = await made;
  expect(overview).toBe(WORLD.world_overview);
  expect(world.plotThreads).toEqual(WORLD.plot_threads);
});

test("an edit that misquotes the world is asked again, and a failed review keeps the world unreviewed", async () => {
  const misquoted = { ...NO_EDITS, world_rules: [{ fault: "contradiction", old: "Not in the world.", new: "Some magic." }] };
  const { made, reviewer } = build(JSON.stringify(WORLD), JSON.stringify(misquoted), new Error("down"));
  let result: Awaited<typeof made> | undefined;
  const log = await logOf(async () => (result = await made));
  expect(reviewer.prompts).toHaveLength(2);
  expect(result!.world.worldRules).toEqual(WORLD.world_rules);
  expect(log).toContain("World kept unreviewed");
});

test("a plot thread rewritten well past a sentence or two is asked again, as the review is told to keep it to a sentence or two", async () => {
  const thread = (words: number) => ({ ...NO_EDITS, plot_threads: [{ fault: "thin_story", old: "The bees are spies.", new: "bee ".repeat(words).trim() }] });
  const { made, reviewer } = build(JSON.stringify(WORLD), JSON.stringify(thread(121)), JSON.stringify(thread(120)));
  const { world } = await made;
  expect(reviewer.prompts).toHaveLength(2);
  expect(world.plotThreads[0]!.split(" ")).toHaveLength(120);
  expect(reviewer.prompts[0]![0]!.content).toContain("Keep each world rule and plot thread to a sentence or two");
  expect(reviewer.prompts[0]![0]!.content).toContain("A name you add, first or surname, starts with one of B, M, T");
});

test("a rewrite of a long thread may run as long as it, with the same leeway", async () => {
  const long = "bee ".repeat(120).trim();
  const fix = { ...NO_EDITS, plot_threads: [{ fault: "contradiction", old: long, new: "wasp ".repeat(150).trim() }] };
  const { made, reviewer } = build(JSON.stringify({ ...WORLD, plot_threads: [long, "The tide is rising."] }), JSON.stringify(fix));
  const { world } = await made;
  expect(reviewer.prompts).toHaveLength(1);
  expect(world.plotThreads[0]!.split(" ")).toHaveLength(150);
});

test("without a reviewer, the world isn't reviewed", async () => {
  const narrator = scriptedTextProvider(JSON.stringify(WORLD));
  await generateWorld({ textProvider: narrator.textProvider, settings: settings() }, CHOICES, PC, SPARKS, signal());
  expect(narrator.prompts).toHaveLength(1);
});

const STATE = { ...openingState, worldRules: ["No magic."], plotThreads: ["The tide is rising."] };
const change = (rule: string) => ({ lore_entries: [], removed_lore: [], plot_threads: [], world_rules: [{ old: "No magic.", new: rule }] });

test("the Journal review's corrected change is the one kept, and null keeps the proposed change", async () => {
  const ask = async (review: object) => {
    const narrator = scriptedTextProvider(JSON.stringify(change("Magic is rare.")));
    const reviewer = scriptedTextProvider(JSON.stringify(review));
    const made = changeWorld(
      { textProvider: narrator.textProvider, reviewProvider: reviewer.textProvider, settings: settings() },
      STATE,
      "make magic rare",
      signal(),
    );
    let result: Awaited<typeof made> | undefined;
    const log = await logOf(async () => (result = await made));
    return { result: result!, log, sent: JSON.parse(reviewer.prompts[0]!.at(-1)!.content) };
  };
  const fixed = await ask({ fixed: ["not_as_asked"], change: change("Magic is rare and costly.") });
  expect(fixed.result.world_rules).toEqual([{ old: "No magic.", new: "Magic is rare and costly." }]);
  expect(fixed.log).toContain('"not_as_asked":1');
  expect(fixed.sent).toMatchObject({ instruction: "make magic rare", proposed_change: { world_rules: [{ new: "Magic is rare." }] } });
  const kept = await ask({ fixed: [], change: null });
  expect(kept.result.world_rules).toEqual([{ old: "No magic.", new: "Magic is rare." }]);
  expect(kept.log).toContain('"outcome":"unchanged"');
});

test("a review must give a proposed first sign, mended where it has a fault, and a kept plan keeps its hours", async () => {
  const thread = { old: "The tide is rising.", new: "The tide is rising.", now: null, plan: "The tide floods the square." };
  const reviewOf = async (corrected: object) => {
    const proposed = { ...change("Magic is rare."), plot_threads: [{ ...thread, plan_in_hours: 6 }], first_sign: "A lamp gutters." };
    const narrator = scriptedTextProvider(JSON.stringify(proposed));
    const reviewer = scriptedTextProvider(
      JSON.stringify({ fixed: ["contradiction"], change: { ...change("Magic is rare and costly."), plot_threads: [thread], ...corrected } }),
    );
    const context = { textProvider: narrator.textProvider, reviewProvider: reviewer.textProvider, settings: settings() };
    const result = await changeWorld(context, STATE, "make magic rare", signal());
    return { result, schema: reviewer.prompts[0]![0]!.content };
  };
  const mended = await reviewOf({ first_sign: "A lamp flickers." });
  expect(mended.result.first_sign).toBe("A lamp flickers.");
  expect(mended.result.plot_threads[0]!.plan_in_hours).toBe(6);
  // The schema the review is sent holds first_sign as a string it must give, not one it may leave null.
  expect(mended.schema).toMatch(/"first_sign":\{"type":"string"/);
});

test("an empty change isn't reviewed, nor is any change when the reviewer has no model", async () => {
  const store = settings();
  const ask = (proposed: object, mayKeep: boolean) => {
    const reviewer = scriptedTextProvider(JSON.stringify({ fixed: [], change: null }));
    const made = changeWorld(
      { textProvider: scriptedTextProvider(JSON.stringify(proposed)).textProvider, reviewProvider: reviewer.textProvider, settings: store },
      STATE,
      "settle",
      signal(),
      mayKeep,
    );
    return made.then(() => reviewer.prompts.length);
  };
  expect(await ask({ lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] }, true)).toBe(0);
  store.update({ reviewOtherModel: true, reviewModel: "" });
  expect(await ask(change("Magic is rare."), false)).toBe(0);
});

test("the reviewer uses its own model, Thinking, and its own server and key only when it isn't on the Narrator's", () => {
  const store = settings();
  store.update({ textApiKey: "main-key", textModel: "narrator/model", textHost: "deepinfra", textHostFallback: false, textThinking: "low" });
  expect(reviewerSettings(store).read()).toMatchObject({ textModel: "narrator/model", textThinking: "low", textHost: "deepinfra", textThinkingTokens: 14_000 });
  store.update({ reviewOtherModel: true, reviewModel: "other/model", reviewThinking: "high" });
  // On the Narrator's server it keeps the player's host and fallback, so a pin chosen for privacy holds for its calls too.
  expect(reviewerSettings(store).read()).toMatchObject({
    textModel: "other/model",
    textApiKey: "main-key",
    textThinking: "high",
    textHost: "deepinfra",
    textHostFallback: false,
  });
  store.update({ reviewSameProvider: false, reviewBaseUrl: "https://nano-gpt.com/api/v1", reviewApiKey: "review-key" });
  expect(reviewerSettings(store).read()).toMatchObject({ textBaseUrl: "https://nano-gpt.com/api/v1", textApiKey: "review-key", textHost: "" });
  // A key only ever goes to the server it was entered for.
  store.update({ reviewBaseUrl: "http://localhost:1234/v1" });
  expect(store.read().reviewApiKey).toBe("");
});
