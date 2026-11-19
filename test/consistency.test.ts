import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { CHECK_LIMIT, checkConsistency, type Name, QUESTIONS, type ReplyToCheck } from "../src/consistency";
import type { Prompt } from "../src/prompt-assembler";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { consistencySettings, type SettingsChange, settingsStore } from "../src/settings-store";
import type { TextProvider } from "../src/turn-engine";
import { logOf, narration, scriptedDice, scriptedImages, scriptedTextProvider, tempFolder, turnEvents } from "./support";

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

const ON: SettingsChange = { textModel: "narrator/model", consistencyEnabled: true, consistencyModel: "glm/check" };
type Claim = { established: string; clash: string; fix: string };
const NO_SLIP = JSON.stringify({ slip: false, established: null, clash: null, fix: null });

/** A Consistency model that answers each question with the claim `claims` names for it, or no slip, and records what it was sent. */
function checker(claims: Partial<Record<Name, Claim>> = {}) {
  const asked: { name: Name; sent: Record<string, unknown>; thinkingBudget?: number }[] = [];
  const provider: TextProvider = async (prompt, { thinkingBudget }) => {
    const sent = JSON.parse(prompt.at(-1)!.content);
    const name = (Object.keys(QUESTIONS) as Name[]).find((each) => QUESTIONS[each].question === sent.question)!;
    asked.push({ name, sent, thinkingBudget });
    const claim = claims[name];
    return claim ? JSON.stringify({ slip: true, ...claim }) : NO_SLIP;
  };
  return { provider, asked };
}

function play(change: SettingsChange, narrator: string[], reviewer: string[], consistencyProvider?: TextProvider, consistencyLogOnly = false) {
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update(change);
  const review = scriptedTextProvider(...reviewer);
  server = startServer({
    savesDir,
    settings,
    textProvider: scriptedTextProvider(...narrator).textProvider,
    reviewProvider: review.textProvider,
    consistencyProvider,
    consistencyLogOnly,
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    writePicture: async (_ask, _style, fallback) => fallback,
    reviewPicture: async (description) => description,
  });
  return review;
}

const store = () => saveStore(savesDir);
const TIME = { op: "set_story_time", days_passed: 0, date: null, time_of_day: "9 pm" };
const createSave = () =>
  store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: { summary: "It rained.", storyTime: { day: 1, date: "First Tide", timeOfDay: "dusk" } },
  });
const turn = (id: string, input = "I count them.") =>
  fetch(new URL(`/saves/${id}/turns`, server!.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ input }),
  });
const NOTHING = JSON.stringify({ state_operations: [] });
const FIRST = narration("Five men stand in a half circle.");
const SECOND = narration("Six men stand in a half circle, lit by low sunlight.", TIME);
const lastNarration = (id: string) => store().messages(id).at(-1)!.text;
const SIX = { established: "Five men stand in a half circle.", clash: "six  MEN", fix: "Five men" };

const REPLY: ReplyToCheck = {
  previous: "Five men.",
  input: "I count them.",
  timeBefore: null,
  timeAfter: null,
  pc: "Ash",
  pcLooks: "",
  wearing: [],
  cast: [],
  facts: [],
  summary: "",
  memories: [],
  knows: {},
  narration: "Six men.",
  visualDescription: "",
};
const consistency = (provider: TextProvider, logOnly = false) => ({
  provider,
  settings: { read: () => ({ textModel: "glm/check" }) } as never,
  enabled: () => true,
  logOnly,
});
const check = (provider: TextProvider, reply: Partial<ReplyToCheck> = {}, usable = () => true) =>
  checkConsistency(consistency(provider), { ...REPLY, ...reply }, usable, new AbortController().signal);

test("with the check off, no question is asked", async () => {
  const { provider, asked } = checker();
  play({ textModel: "narrator/model" }, [FIRST], [NOTHING], provider);
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(asked).toEqual([]);
  expect(log).not.toContain('"consistency"');
});

test("each question is asked in a call of its own with only its slice, and the Turn logs counts and no story text", async () => {
  const { provider, asked } = checker();
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], provider);
  const id = createSave();
  await turn(id);
  asked.length = 0;

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  const byName = Object.fromEntries(asked.map(({ name, sent }) => [name, sent]));
  // The time before the reply, and after the Narrator's own operations moved it on.
  expect(byName.time).toMatchObject({ established: { story_time_before: "First Tide, dusk", story_time_after: "First Tide, 9 pm" } });
  expect(byName.continuity).toMatchObject({ established: { previous_reply: "Five men stand in a half circle." }, player_move: "I count them." });
  // Who is present as the reply starts: the PC with what they have on, not what they carry.
  expect(byName.description!.established).toEqual({ people: [{ name: "Ash", is_pc: true, looks: "", wearing: [] }] });
  expect(byName.past).toMatchObject({ established: { known_facts: [], scene_memories: [] }, reply: expect.stringContaining("Six men") });
  expect(asked.map(({ thinkingBudget }) => thinkingBudget)).toEqual([1500, 1500, 1500, 1500]);
  expect(log).toMatch(/"consistency":\{"model":"glm\/check","calls":4,"claimed":0,"verified":0,"edits":0,"ms":\d+,"outcome":"passed"\}/);
  expect(log).not.toContain("Six men");
});

test("a claim whose quotes are both found is fixed, taking the streamed reply's place, and the revision is timed", async () => {
  const { provider } = checker({ continuity: SIX });
  const review = play(ON, [FIRST, SECOND], [NOTHING, NOTHING], provider);
  const id = createSave();
  await turn(id);

  let events: Awaited<ReturnType<typeof turnEvents>> = [];
  const log = await logOf(async () => (events = await turnEvents(await turn(id))), "info");

  expect(lastNarration(id)).toBe("Five men stand in a half circle, lit by low sunlight.");
  expect(events.find(({ event }) => event === "revise")?.data).toEqual({ text: "Five men stand in a half circle, lit by low sunlight." });
  expect(log).toContain('"claimed":1,"verified":1,"edits":1');
  expect(log).toContain('"outcome":"fixed"');
  expect(log).toMatch(/Reply revised .*"ms":\d+/);
  // State Upkeep reads the fixed reply.
  expect(review.prompts[1]!.at(-1)!.content).toContain("Five men stand");
});

test("a claim whose established words weren't sent, or whose clash isn't in the reply, is dropped and logged", async () => {
  for (const claim of [
    { ...SIX, established: "Seven men came." },
    { ...SIX, clash: "Nine men" },
  ]) {
    let result: Awaited<ReturnType<typeof check>> | undefined;
    const log = await logOf(async () => {
      result = await check(checker({ continuity: claim }).provider);
    }, "info");
    expect(result!.narration).toBe("Six men.");
    expect(result!.checked).toMatchObject({ claimed: 1, verified: 0, outcome: "passed" });
    expect(log).toContain("Slip claim dropped");
  }
});

test("the default Consistency model is the reviewer's, on its server with the player's host, always at Low", () => {
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textModel: "narrator/model", textHost: "DeepInfra", textThinking: "high", reviewOtherModel: true, reviewModel: "deepseek/review" });
  expect(consistencySettings(settings).read()).toMatchObject({ textModel: "deepseek/review", textHost: "DeepInfra", textThinking: "low" });

  settings.update({ consistencyModel: "glm/check" });
  expect(consistencySettings(settings).read()).toMatchObject({ textModel: "glm/check", textHost: "DeepInfra", textThinking: "low" });

  settings.update({ consistencySameProvider: false, consistencyBaseUrl: "https://api.nano-gpt.com/api/v1", consistencyApiKey: "own-key" });
  expect(consistencySettings(settings).read()).toMatchObject({ textBaseUrl: "https://api.nano-gpt.com/api/v1", textApiKey: "own-key", textHost: "" });
});

test("with no Consistency model provider, the reviewer's checks the reply", async () => {
  const asked: Prompt[] = [];
  const reviewer: TextProvider = async (prompt) => {
    const checking = prompt[0]!.content.includes("for one kind of slip");
    if (checking) asked.push(prompt);
    return checking ? NO_SLIP : NOTHING;
  };
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update(ON);
  server = startServer({
    savesDir,
    settings,
    textProvider: scriptedTextProvider(FIRST).textProvider,
    reviewProvider: reviewer,
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    writePicture: async (_ask, _style, fallback) => fallback,
    reviewPicture: async (description) => description,
  });

  expect((await turn(createSave())).ok).toBe(true);
  expect(asked.length).toBeGreaterThan(0);
});

test("the Turn's Check is sent, and a fix that would undo what it decided keeps the reply as the Narrator wrote it", async () => {
  const { provider, asked } = checker({ continuity: { established: "A door.", clash: "It holds.", fix: "It opens." } });
  const decided = { action: "Pick the lock", difficulty: "hard", roll: 1, outcome: "failure", degree: "critical" } as never;
  const result = await check(provider, { previous: "A door.", input: "I pick it.", narration: "It holds.", check: decided }, () => false);

  expect(asked.find(({ name }) => name === "continuity")!.sent.check_result).toEqual({ action: "Pick the lock", outcome: "failure", degree: "critical" });
  expect(result.narration).toBe("It holds.");
  expect(result.checked.outcome).toBe("fix failed");
});

test("fixes from several questions are made together, skipping one an earlier edit changed, and the picture's words too", async () => {
  const { provider } = checker({
    continuity: { ...SIX, established: "five men." },
    past: { established: "Five men came.", clash: "Six men", fix: "Seven men" },
    description: { established: "Ash", clash: "wet", fix: "dry" },
  });
  const result = await check(provider, { facts: ["Five men came."], narration: "Six men, wet.", visualDescription: "Six men on a pier." });

  expect(result.narration).toBe("Five men, dry.");
  expect(result.visualDescription).toBe("Five men on a pier.");
  expect(result.checked).toMatchObject({ calls: 3, claimed: 3, verified: 3, edits: 2, outcome: "fixed" });
});

test("a fix that takes out what the player's move did isn't made", async () => {
  const { provider } = checker({ continuity: { established: "Five men.", clash: "Ash shouts for the guards.", fix: "Ash keeps silent." } });
  const result = await check(provider, { input: "I shout for the guards.", narration: "Ash shouts for the guards. Six men come." });

  expect(result.narration).toBe("Ash shouts for the guards. Six men come.");
  expect(result.checked.verified).toBe(0);
});

test("a question past its time limit lets the reply through unanswered", async () => {
  const limit = CHECK_LIMIT.ms;
  CHECK_LIMIT.ms = 20;
  const stalled: TextProvider = (_prompt, { signal }) =>
    new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  try {
    const result = await check(stalled);
    expect(result.narration).toBe("Six men.");
    expect(result.checked.outcome).toBe("unanswered");
  } finally {
    CHECK_LIMIT.ms = limit;
  }
});

test("a fix that speaks for the PC is refused, as a Narrator reply would be", async () => {
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], checker({ continuity: { ...SIX, fix: "[Ash]: “Five.”\nFive men" } }).provider);
  const id = createSave();
  await turn(id);
  await turn(id);

  expect(lastNarration(id)).toContain("Six men");
});

test("with --consistency-log-only, every question is asked and logged and nothing is fixed", async () => {
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], checker({ continuity: SIX }).provider, true);
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(lastNarration(id)).toContain("Six men");
  expect(log).toContain('"claimed":1,"verified":1,"edits":0');
  expect(log).toContain('"outcome":"logged"');
});
