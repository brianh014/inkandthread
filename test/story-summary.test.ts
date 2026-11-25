import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { OPENING_INPUT, SUMMARY_EVERY } from "../src/prompt-assembler";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { openingState } from "../src/state-applier";
import { keepSummary, nextSummary, summaryDue } from "../src/story-summary";
import { ContentRefused, type TextProvider } from "../src/turn-engine";
import { logOf, narration, scriptedDice, scriptedImages, scriptedTextProvider, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let server: ReturnType<typeof startServer> | undefined;

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  folder.remove();
});

const settingsWith = (textModel = "narrator/model") => {
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update({ textModel });
  return settings;
};
/** Replies of the story, each with the move before it, as Messages, the last of them the newest. */
const story = (replies: number) =>
  Array.from({ length: replies }, (_, index) => [
    { id: index * 2 + 1, role: "player" as const, text: index === 0 ? OPENING_INPUT : `Move ${index}.` },
    { id: index * 2 + 2, role: "narrator" as const, text: `Reply ${index}.` },
  ]).flat();
const by = (provider: TextProvider, textModel?: string) => ({ provider, narrator: scriptedTextProvider().textProvider, settings: settingsWith(textModel) });
const known = {
  sceneMemories: [
    { firstMessage: 1, lastMessage: 2, text: "They met." },
    { firstMessage: 50, lastMessage: 52, text: "They parted." },
  ],
  pcKnown: { facts: ["The tap drips."], npcs: [] },
};
const { signal } = new AbortController();
const ask = (reply: string | Error, replies: number, state = { summary: "It began.", summaryReplies: 0 }, own = false) => {
  const scribe = scriptedTextProvider(reply);
  const written = nextSummary(by(scribe.textProvider), "Ash", { ...known, ...state }, story(replies), signal, own);
  return { written, sent: async () => (await written, JSON.parse(scribe.prompts[0]![1]!.content)) };
};
const summed = (summary: unknown) => JSON.stringify({ summary });

test("the summary is due every few replies, at the first reply there is none, and again until one comes", () => {
  expect(summaryDue({ summary: "", summaryReplies: 0 }, 0)).toBe(false);
  expect(summaryDue({ summary: "", summaryReplies: 0 }, 1)).toBe(true);
  const due = Array.from({ length: SUMMARY_EVERY + 2 }, (_, replies) => summaryDue({ summary: "So far.", summaryReplies: 1 }, replies + 1));
  expect(due).toEqual([false, false, false, false, false, true, true]);
});

test("the Scribe is sent the page alone: the summary so far and the Messages it doesn't cover, never the newest reply", async () => {
  const asked = ask(summed("Ash came and went."), 8, { summary: "It began.", summaryReplies: 2 });

  expect(await asked.written).toEqual({ summary: "Ash came and went.", replies: 7 });
  const sent = await asked.sent();
  expect(Object.keys(sent)).toEqual(["pc_name", "older_scenes", "pc_knows", "summary", "messages"]);
  expect(sent).toMatchObject({ older_scenes: ["They met."], pc_knows: ["The tap drips."], summary: "It began." });
  expect(sent.messages.map(({ text }: { text: string }) => text)).toEqual([2, 3, 4, 5, 6].flatMap((n) => [`Move ${n}.`, `Reply ${n}.`]));
});

test("what the player left out of a summary they wrote isn't sent again", async () => {
  const sent = await ask(summed("It went on."), 8, { summary: "It began.", summaryReplies: 2 }, true).sent();
  expect(sent).toMatchObject({ older_scenes: [], pc_knows: [] });
});

test("a story left long without one catches up oldest first, with nothing from after it, and an older Save is sent its latest", async () => {
  const behind = ask(summed("So it went."), 31, { summary: "So far.", summaryReplies: 4 });
  expect(await behind.written).toEqual({ summary: "So it went.", replies: 14 });
  expect(await behind.sent()).toMatchObject({ older_scenes: ["They met."], pc_knows: [] });
  // A blank one covers nothing, whatever it says.
  expect(await ask(summed("So it went."), 31, { summary: "", summaryReplies: 20 }).written).toEqual({ summary: "So it went.", replies: 10 });

  const older = ask(summed("So it went."), 31);
  expect(await older.written).toEqual({ summary: "So it went.", replies: 30 });
  expect((await older.sent()).messages.filter(({ role }: { role: string }) => role === "narrator")).toHaveLength(2 * SUMMARY_EVERY);
  // An opening's marker is no move.
  expect((await ask(summed("It began."), 2, { summary: "", summaryReplies: 0 }).sent()).messages).toEqual([{ role: "narrator", text: "Reply 0." }]);
});

test("a summary that is missing, blank or cut to a fraction of the last is not taken", async () => {
  const long = { summary: "one two three four five six seven eight nine ten", summaryReplies: 0 };
  expect(await ask(summed("one two three"), 7, long).written).toBeNull();
  expect(await ask(summed("one two three four five"), 7, long).written).toEqual({ summary: "one two three four five", replies: 6 });
  for (const bad of [summed("  "), summed(7), summed(null), new Error("down")]) expect(await ask(bad, 7).written).toBeNull();
});

test("a summary another model refuses is asked of the Narrator, which the log names", async () => {
  const settings = settingsWith();
  settings.update({ reviewOtherModel: true, reviewModel: "scribe/model" });
  const provider = scriptedTextProvider(new ContentRefused("policy")).textProvider;
  const narrator = scriptedTextProvider(summed("It went on.")).textProvider;
  let written: unknown;
  const log = await logOf(async () => {
    written = await nextSummary({ provider, narrator, settings }, "Ash", { ...known, summary: "It began.", summaryReplies: 1 }, story(7), signal);
  }, "info");
  expect(written).toEqual({ summary: "It went on.", replies: 6 });
  expect(log).toMatch(/Summary written .*"model":"narrator\/model"/);
});

test("no Scribe's model is asked for none", async () => {
  const scribe = scriptedTextProvider();
  expect(await nextSummary(by(scribe.textProvider, ""), "Ash", { ...known, summary: "", summaryReplies: 0 }, story(3), signal)).toBeNull();
  expect(scribe.prompts).toEqual([]);
});

test("a summary is written after the Turn, so a slow one never holds it, and a Regenerate keeps it", async () => {
  const narrator = scriptedTextProvider(narration("One."), narration("Two."), narration("Two again."), narration("Three."));
  let give = (_: string) => {};
  const asked: string[] = [];
  server = startServer({
    savesDir,
    settings: settingsWith(),
    textProvider: narrator.textProvider,
    moveWorld: true,
    reviewProvider: async (prompt) => {
      if (!prompt[0]!.content.startsWith("You keep the summary")) return JSON.stringify({ state_operations: [] });
      asked.push(prompt[1]!.content);
      return new Promise<string>((resolve) => (give = resolve));
    },
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    writePicture: async (_ask, _style, fallback) => fallback,
    reviewPicture: async (description) => description,
  });
  const store = saveStore(savesDir);
  const id = store.create({ worldBrief: "A drowned city", pc: { name: "Ash" }, opening: { plotThreads: ["HIDDEN-TRUTH"] } });
  const post = (path: string, body: object = {}) =>
    fetch(new URL(`/saves/${id}/${path}`, server!.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  expect((await post("turns", { input: "I wait." })).status).toBe(201);
  expect(asked).toEqual([]);
  // Back before the summary is written.
  expect((await post("turns", { input: "I wait." })).status).toBe(201);
  expect(store.latestState(id).summary).toBe("");
  for (let tries = 0; asked.length === 0 && tries < 100; tries++) await Bun.sleep(5);
  expect(asked[0]).not.toContain("HIDDEN-TRUTH");
  expect(asked[0]).not.toContain("Two.");
  give(summed("SUMMARY-ONE"));
  for (let tries = 0; store.latestState(id).summary === "" && tries < 100; tries++) await Bun.sleep(5);
  expect(store.latestState(id)).toMatchObject({ summary: "SUMMARY-ONE", summaryReplies: 1 });

  expect((await post("messages/4/regenerate")).status).toBe(201);
  expect(store.latestState(id)).toMatchObject({ summary: "SUMMARY-ONE", summaryReplies: 1 });
  expect((await post("turns", { input: "I go." })).status).toBe(201);
  expect(JSON.stringify(narrator.prompts[3])).toContain("SUMMARY-ONE");
  expect(asked).toHaveLength(1);
});

test("a summary is never written over one the player changed meanwhile", async () => {
  const store = saveStore(savesDir);
  const id = store.create({ worldBrief: "A drowned city", pc: { name: "Ash" } });
  for (const [input, text] of [
    ["I wait.", "One."],
    ["I go.", "Two."],
  ] as const)
    store.commitTurn(id, store.latestMessageId(id), input, text, undefined, (state) => ({ ...state, summary: openingState.summary }), undefined);
  const provider: TextProvider = async () => {
    store.addEdit(id, { edit: "summary", text: "Mine." });
    return summed("The Scribe's.");
  };

  const log = await logOf(() => keepSummary(by(provider), store, id), "info");

  expect(store.latestState(id).summary).toBe("Mine.");
  expect(log).toContain("Summary dropped");
});
