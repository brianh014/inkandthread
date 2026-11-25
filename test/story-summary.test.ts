import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { OPENING_INPUT, SUMMARY_EVERY } from "../src/prompt-assembler";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { nextSummary, summaryDue } from "../src/story-summary";
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
/** Replies of the story, each with the move before it, as Messages. */
const story = (replies: number) =>
  Array.from({ length: replies }, (_, index) => [
    { id: index * 2 + 1, role: "player" as const, text: index === 0 ? OPENING_INPUT : `Move ${index}.` },
    { id: index * 2 + 2, role: "narrator" as const, text: `Reply ${index}.` },
  ]).flat();
const by = (provider?: TextProvider) => ({ provider, narrator: scriptedTextProvider().textProvider });
const known = { sceneMemories: [{ firstMessage: 1, lastMessage: 2, text: "They met." }], pcKnown: { facts: ["The tap drips."], npcs: [] } };
const ask = (reply: string | Error, replies: number, state = { summary: "It began.", summaryReplies: 0 }) => {
  const scribe = scriptedTextProvider(reply);
  return {
    scribe,
    written: nextSummary({ ...by(scribe.textProvider), settings: settingsWith() }, "Ash", { ...known, ...state }, story(replies), new AbortController().signal),
  };
};
const summed = (summary: unknown) => JSON.stringify({ summary });

test("the summary is due every few replies, at the first reply there is none, and again until one comes", () => {
  expect(summaryDue({ summary: "", summaryReplies: 0 }, 0)).toBe(false);
  expect(summaryDue({ summary: "", summaryReplies: 0 }, 1)).toBe(true);
  const due = Array.from({ length: SUMMARY_EVERY + 2 }, (_, replies) => summaryDue({ summary: "So far.", summaryReplies: 1 }, replies + 1));
  expect(due).toEqual([false, false, false, false, false, true, true]);
});

test("the Scribe is sent the page alone: the summary so far and the Messages it doesn't cover", async () => {
  const { scribe, written } = ask(summed("Ash came and went."), 7, { summary: "It began.", summaryReplies: 2 });

  expect(await written).toEqual({ text: "Ash came and went.", replies: 7 });
  const sent = JSON.parse(scribe.prompts[0]![1]!.content);
  expect(Object.keys(sent)).toEqual(["pc_name", "older_scenes", "pc_knows", "summary", "messages"]);
  expect(sent).toMatchObject({ older_scenes: ["They met."], pc_knows: ["The tap drips."] });
  expect(sent.messages.map(({ text }: { text: string }) => text)).toEqual([2, 3, 4, 5, 6].flatMap((n) => [`Move ${n}.`, `Reply ${n}.`]));
  expect(scribe.prompts[0]![0]!.content).toContain("under 500 words");
});

test("a story left long without one catches up oldest first, an older Save is sent its latest, and an opening's marker never goes", async () => {
  expect(await ask(summed("So it went."), 30, { summary: "So far.", summaryReplies: 4 }).written).toEqual({ text: "So it went.", replies: 14 });
  const long = ask(summed("So it went."), 30);
  expect(await long.written).toEqual({ text: "So it went.", replies: 30 });
  const sent = JSON.parse(long.scribe.prompts[0]![1]!.content).messages;
  expect(sent.filter(({ role }: { role: string }) => role === "narrator")).toHaveLength(2 * SUMMARY_EVERY);

  const first = ask(summed("It began."), 1, { summary: "", summaryReplies: 0 });
  await first.written;
  expect(JSON.parse(first.scribe.prompts[0]![1]!.content).messages).toEqual([{ role: "narrator", text: "Reply 0." }]);
});

test("a summary that is missing, blank or cut to a fraction of the last is not taken", async () => {
  const long = { summary: "one two three four five six seven eight nine ten", summaryReplies: 0 };
  expect(await ask(summed("one two three"), 6, long).written).toBeNull();
  expect(await ask(summed("one two three four five"), 6, long).written).toEqual({ text: "one two three four five", replies: 6 });
  for (const bad of [summed("  "), summed(7), summed(null), new Error("down")]) expect(await ask(bad, 6).written).toBeNull();
});

test("a summary another model refuses is asked of the Narrator", async () => {
  const settings = settingsWith();
  settings.update({ reviewOtherModel: true, reviewModel: "scribe/model" });
  const scribe = scriptedTextProvider(new ContentRefused("policy"));
  const narrator = scriptedTextProvider(summed("It went on."));
  const from = { provider: scribe.textProvider, narrator: narrator.textProvider, settings };
  expect(await nextSummary(from, "Ash", { ...known, summary: "It began.", summaryReplies: 1 }, story(6), new AbortController().signal)).toEqual({
    text: "It went on.",
    replies: 6,
  });
});

test("no Scribe, or no model for it, is asked for none", async () => {
  const { signal } = new AbortController();
  expect(await nextSummary({ ...by(undefined), settings: settingsWith() }, "Ash", { ...known, summary: "", summaryReplies: 0 }, story(3), signal)).toBeNull();
  const scribe = scriptedTextProvider();
  expect(
    await nextSummary({ ...by(scribe.textProvider), settings: settingsWith("") }, "Ash", { ...known, summary: "", summaryReplies: 0 }, story(3), signal),
  ).toBeNull();
  expect(scribe.prompts).toEqual([]);
});

test("a Turn takes the summary due beside it, which later prompts carry, a Revert undoes, and one that fails costs nothing", async () => {
  const narrator = scriptedTextProvider(narration("One."), narration("Two."), narration("Three."), narration("Four."));
  const scribed: (string | Error)[] = [summed("SUMMARY-ONE"), new Error("down")];
  const asked: string[] = [];
  server = startServer({
    savesDir,
    settings: settingsWith(),
    textProvider: narrator.textProvider,
    reviewProvider: async (prompt) => {
      if (!prompt[0]!.content.startsWith("You keep the summary")) return JSON.stringify({ state_operations: [] });
      asked.push(prompt[1]!.content);
      const reply = scribed.shift() ?? new Error("exhausted");
      if (reply instanceof Error) throw reply;
      return reply;
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
  const turn = () =>
    fetch(`${server!.url}saves/${id}/turns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "I wait." }) });

  expect((await turn()).status).toBe(201);
  expect(asked).toEqual([]);
  const log = await logOf(async () => expect((await turn()).status).toBe(201), "info");
  expect(store.latestState(id)).toMatchObject({ summary: "SUMMARY-ONE", summaryReplies: 1 });
  expect(asked[0]).not.toContain("HIDDEN-TRUTH");
  expect(log).toContain("Summary written");
  expect(log).not.toContain("SUMMARY-ONE");
  expect((await turn()).status).toBe(201);
  expect(JSON.stringify(narrator.prompts[2])).toContain("SUMMARY-ONE");

  // Back to the first reply, which had none, so the next Turn asks again, and fails.
  expect((await fetch(`${server.url}saves/${id}/messages/2/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).ok).toBe(
    true,
  );
  expect(store.latestState(id).summary).toBe("");
  expect((await turn()).status).toBe(201);
  expect(asked).toHaveLength(2);
  expect(store.latestState(id).summary).toBe("");
});
