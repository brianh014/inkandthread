import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { CUT_OFFS, checkConsistency, FIX_LIMIT } from "../src/consistency";
import { slowReviewer } from "../src/state-upkeep";
import { type DecisionProvider, decisionModels, decisionProvider } from "../src/decisions";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { type SettingsChange, settingsStore } from "../src/settings-store";
import { logOf, narration, scriptedDice, scriptedImages, scriptedTextProvider, tempFolder, turnEvents } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let server: ReturnType<typeof startServer> | undefined;
const tuned = structuredClone(CUT_OFFS);

beforeEach(() => {
  // Shared by every Save, so one test's time-out would lower another's thinking.
  slowReviewer.steps = 0;
  slowReviewer.quick = 0;
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});
afterEach(async () => {
  Object.assign(CUT_OFFS, structuredClone(tuned));
  await server?.stop(true);
  server = undefined;
  folder.remove();
});

const ON: SettingsChange = { textModel: "narrator/model", consistencyEnabled: true, consistencyModel: "openai/gpt-6-luna-decisions" };

/** A decision model that gives each question the score `scores` names, or 0.02, and records what it was sent. */
function decisions(scores: Record<string, number> = {}) {
  const asked: { state: Record<string, unknown>; questions: string[] }[] = [];
  const decide: DecisionProvider = async (state, questions) => {
    asked.push({ state, questions: Object.keys(questions) });
    return { answers: Object.fromEntries(Object.keys(questions).map((name) => [name, scores[name] ?? 0.02])), model: "luna" };
  };
  return { decide, asked };
}

function play(change: SettingsChange, narrator: string[], reviewer: string[], decide: DecisionProvider, consistencyLogOnly = false) {
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update(change);
  const review = scriptedTextProvider(...reviewer);
  server = startServer({
    savesDir,
    settings,
    textProvider: scriptedTextProvider(...narrator).textProvider,
    reviewProvider: review.textProvider,
    decisionProvider: decide,
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

test("with the Consistency model off, no question is asked", async () => {
  const { decide, asked } = decisions();
  play({ textModel: "narrator/model" }, [FIRST], [NOTHING], decide);
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(asked).toEqual([]);
  expect(log).not.toContain('"consistency"');
});

test("each question is asked on its own with only its slice, and its score is logged with the Turn and no story text", async () => {
  const { decide, asked } = decisions({ time: 0.4 });
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], decide);
  const id = createSave();
  await turn(id);
  asked.length = 0;

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  const byName = Object.fromEntries(asked.map(({ state, questions }) => [questions.join(), state]));
  // The time before the reply, and after the Narrator's own operations moved it on.
  expect(byName.time).toEqual({ story_time_before: "First Tide, dusk", story_time_after: "First Tide, 9 pm", reply: expect.stringContaining("Six men") });
  expect(byName.continuity).toEqual({
    previous_reply: "Five men stand in a half circle.",
    player_input: "I count them.",
    reply: expect.stringContaining("Six men"),
  });
  // Who is present as the reply starts: the PC with what they have on, not what they carry.
  expect(byName.description).toEqual({ people: [{ name: "Ash", is_pc: true, looks: "", wearing: [] }], reply: expect.stringContaining("Six men") });
  expect(byName.past).toMatchObject({ known_facts: [], scene_memories: [], reply: expect.stringContaining("Six men") });
  expect(log).toContain('"consistency":{"model":"luna","scores":{"time":0.4,"continuity":0.02,"description":0.02,"past":0.02},"outcome":"passed"}');
  expect(log).not.toContain("Six men");
});

test("a question over its cut-off has the reviewer fix the reply and its picture, which takes the streamed reply's place", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  const fix = JSON.stringify({ narration_edits: [{ old: "Six men", new: "Five men" }], visual_description_edits: [] });
  const { decide } = decisions({ continuity: 0.99 });
  const review = play(ON, [FIRST, SECOND], [NOTHING, fix, NOTHING], decide);
  const id = createSave();
  await turn(id);

  let events: Awaited<ReturnType<typeof turnEvents>> = [];
  const log = await logOf(async () => (events = await turnEvents(await turn(id))), "info");

  expect(lastNarration(id)).toBe("Five men stand in a half circle, lit by low sunlight.");
  expect(events.find(({ event }) => event === "revise")?.data).toEqual({ text: "Five men stand in a half circle, lit by low sunlight." });
  expect(log).toContain('"outcome":"fixed"');
  // The fix is sent the flagged question and its slice, then State Upkeep reads the fixed reply.
  expect(review.prompts[1]!.at(-1)!.content).toContain("previous_reply");
  expect(review.prompts[2]!.at(-1)!.content).toContain("Five men stand");
});

test("a reviewer that gives no edits leaves the reply as it was, logged as not a slip rather than fixed", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  const none = JSON.stringify({ narration_edits: [], visual_description_edits: [] });
  play(ON, [FIRST, SECOND], [NOTHING, none, NOTHING], decisions({ continuity: 0.99 }).decide);
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(lastNarration(id)).toContain("Six men");
  expect(log).toContain('"outcome":"not a slip"');
});

test("a model with its own cut-offs is judged by them, not Liquid D1.2's", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  CUT_OFFS.luna = { ...CUT_OFFS["liquid/d1.2"]!, continuity: 1.01 };
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], decisions({ continuity: 0.99 }).decide);
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(log).toContain('"outcome":"passed"');
  delete CUT_OFFS.luna;
});

test("a fix that runs past its time limit keeps the reply as the Narrator wrote it", async () => {
  const limit = FIX_LIMIT.ms;
  FIX_LIMIT.ms = 20;
  // A reviewer that answers only when stopped, as one asked again and again would keep the choices waiting.
  const stalled = (_prompt: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const reply = {
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
  try {
    const checked = await checkConsistency(
      { decide: decisions({ continuity: 0.99 }).decide, enabled: () => true, logOnly: false },
      stalled,
      reply,
      () => true,
      new AbortController().signal,
    );
    expect(checked.narration).toBe("Six men.");
    expect(checked.checked.outcome).toBe("fix failed");
  } finally {
    FIX_LIMIT.ms = limit;
  }
});

test("the fix asks the reviewer to think a level below Review thinking, from its first try", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  const asked: (number | undefined)[] = [];
  const reviewer = async (_prompt: unknown, { lessThinking }: { lessThinking?: number }) => {
    asked.push(lessThinking);
    return JSON.stringify({ narration_edits: [{ old: "Six men", new: "Five men" }], visual_description_edits: [] });
  };
  const reply = {
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
  const fixed = await checkConsistency(
    { decide: decisions({ continuity: 0.99 }).decide, enabled: () => true, logOnly: false },
    reviewer,
    reply,
    () => true,
    new AbortController().signal,
  );
  expect(fixed.narration).toBe("Five men.");
  expect(asked).toEqual([1]);
});

test("the fix is shown the Turn's Check, to keep what it decided", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  let sent = "";
  const reviewer = async (prompt: { content: string }[]) => {
    sent = prompt.at(-1)!.content;
    return JSON.stringify({ narration_edits: [], visual_description_edits: [] });
  };
  const check = { action: "Pick the lock", difficulty: "hard", roll: 1, outcome: "failure", degree: "critical" };
  const reply = { previous: "A door.", input: "I pick it.", timeBefore: null, timeAfter: null, pc: "Ash", pcLooks: "", wearing: [], cast: [], facts: [] };
  await checkConsistency(
    { decide: decisions({ continuity: 0.99 }).decide, enabled: () => true, logOnly: false },
    reviewer,
    { ...reply, summary: "", memories: [], knows: {}, narration: "It holds.", visualDescription: "", check } as never,
    () => true,
    new AbortController().signal,
  );
  expect(JSON.parse(sent).check_result).toEqual({ action: "Pick the lock", outcome: "failure", degree: "critical" });
});

test("a reply no question answered is logged as unanswered, not passed", async () => {
  const unanswered: DecisionProvider = async () => ({ answers: {}, model: "liquid/d1.2" });
  const reply = {
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
  const { checked } = await checkConsistency(
    { decide: unanswered, enabled: () => true, logOnly: false },
    undefined,
    reply,
    () => true,
    new AbortController().signal,
  );
  expect(checked.outcome).toBe("unanswered");
});

test("a fix that can't be placed keeps the reply as the Narrator wrote it", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  const fix = JSON.stringify({ narration_edits: [{ old: "Seven men", new: "Five men" }], visual_description_edits: [] });
  play(ON, [FIRST, SECOND], [NOTHING, fix, NOTHING], decisions({ continuity: 0.99 }).decide);
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(lastNarration(id)).toContain("Six men");
  expect(log).toContain('"outcome":"fix failed"');
  expect(log).toContain("Reply kept unfixed");
});

test("a fix that speaks for the PC is refused, as a Narrator reply would be", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  const fix = JSON.stringify({ narration_edits: [{ old: "Six men", new: "[Ash]: “Five.”\nFive men" }], visual_description_edits: [] });
  play(ON, [FIRST, SECOND], [NOTHING, fix, NOTHING], decisions({ continuity: 0.99 }).decide);
  const id = createSave();
  await turn(id);
  await turn(id);

  expect(lastNarration(id)).toContain("Six men");
});

test("with --consistency-log-only, every question scores and logs and nothing is fixed", async () => {
  CUT_OFFS["liquid/d1.2"]!.continuity = 0.9;
  play(ON, [FIRST, SECOND], [NOTHING, NOTHING], decisions({ continuity: 0.99 }).decide, true);
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(lastNarration(id)).toContain("Six men");
  expect(log).toContain('"continuity":0.99,"description":0.02,"past":0.02},"outcome":"logged"');
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the decision client asks OpenRouter's Decisions address, reads a refusal as not answered, and reports the cost", async () => {
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ ...ON, textApiKey: "or-key" });
  const sent: { url: string; body: unknown }[] = [];
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (String(url).includes("/models")) return reply({ data: [{ id: "openai/gpt-6-luna-decisions", context_length: 128_000 }] });
    sent.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return reply({ answers: { time: { type: "noul", noul: 0.97 }, continuity: { type: "refusal" } }, usage: { input_tokens: 90, cost: 0.0002 } });
  }) as typeof fetch);
  const usage: unknown[] = [];
  try {
    const decide = decisionProvider(settings, (counted) => usage.push(counted));
    const question = { type: "noul" as const, instructions: "?", criteria: { true: "yes", false: "no" } };
    const { answers } = await decide({ reply: "Rain." }, { time: question, continuity: question }, new AbortController().signal);

    expect(answers).toEqual({ time: 0.97, continuity: undefined });
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(sent[0]!.body).toMatchObject({ model: "openai/gpt-6-luna-decisions", state: { reply: "Rain." } });
    expect(usage).toEqual([{ provider: "openrouter.ai", model: "openai/gpt-6-luna-decisions", failed: false, tokensIn: 90, cost: 0.0002 }]);
  } finally {
    fetched.mockRestore();
  }
});

test("a decision logs its scores at Verbose, and what it was shown only with Story in log", async () => {
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ ...ON, textApiKey: "or-key" });
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (url: string) =>
    String(url).includes("/models")
      ? reply({ data: [] })
      : reply({ answers: { time: { type: "noul", noul: 0.97 } }, usage: { cost: 0.0002 } })) as typeof fetch);
  const question = { type: "noul" as const, instructions: "?", criteria: { true: "yes", false: "no" } };
  const ask = () => decisionProvider(settings)({ reply: "Rain on the dunes." }, { time: question }, new AbortController().signal);
  try {
    const plain = await logOf(ask);
    expect(plain).toContain('Decision {"model":"openai/gpt-6-luna-decisions","answers":{"time":{"type":"noul","noul":0.97}}');
    expect(plain).not.toContain("Rain on the dunes.");

    settings.update({ storyInLog: true });
    expect(await logOf(ask, "error")).toContain(
      'Decision request text {"model":"openai/gpt-6-luna-decisions","state":{"reply":"Rain on the dunes."},"questions":["time"]}',
    );
  } finally {
    fetched.mockRestore();
  }
});

test("a decision request that fails lets the reply through unanswered, and is counted as failed", async () => {
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update(ON);
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (url: string) =>
    String(url).includes("/models") ? reply({ data: [] }) : reply({ error: "busy" }, 503)) as typeof fetch);
  const usage: { failed: boolean }[] = [];
  try {
    const question = { type: "noul" as const, instructions: "?", criteria: { true: "yes", false: "no" } };
    const { answers } = await decisionProvider(settings, (counted) => usage.push(counted))(
      { reply: "Rain." },
      { time: question },
      new AbortController().signal,
    );
    expect(answers).toEqual({});
    expect(usage[0]!.failed).toBe(true);
  } finally {
    fetched.mockRestore();
  }
});

test("the decision model list is the Consistency model's server's, without the models too small to hold a reply", async () => {
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ ...ON, textBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", consistencyBaseUrl: "https://api.nano-gpt.com/api/v1" });
  const asked: string[] = [];
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    asked.push(String(url));
    return reply({
      data: [{ id: "perplexity/pplx-decider-v1.2", context_length: 262_000 }, { id: "cloudflare/clef", context_length: 1_800 }, { id: "liquid/d1" }],
    });
  }) as typeof fetch);
  try {
    const models = await decisionModels(settings, new AbortController().signal);
    // Google has no decision models, so "Same provider" gives way to the Consistency model's own.
    expect(asked).toEqual(["https://api.nano-gpt.com/api/v1/models?output_modalities=decisions"]);
    expect(models.map(({ id }) => id)).toEqual(["perplexity/pplx-decider-v1.2", "liquid/d1"]);
  } finally {
    fetched.mockRestore();
  }
});
