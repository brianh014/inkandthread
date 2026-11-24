import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { SUMMARY_EVERY } from "../src/prompt-assembler";
import { saveStore } from "../src/save-store";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let app: ReturnType<typeof startApp>;
let prompts: ReturnType<typeof scriptedTextProvider>["prompts"];

const play = (...replies: string[]) => {
  const provider = scriptedTextProvider(...replies);
  prompts = provider.prompts;
  app = startApp(join(folder.path, "Saves"), provider.textProvider);
};

beforeEach(() => {
  folder = tempFolder();
});

afterEach(async () => {
  await app.stop();
  folder.remove();
});

const summed = (summary: unknown, ...state_operations: object[]) =>
  JSON.stringify({ check: null, narration: "Rain.", state_operations, summary, scene_changed: false, visual_description: "" });

const summaryOf = async (id: string) => ((await app.get(`/saves/${id}/journal`).then((r) => r.json())) as { summary: string }).summary;
const playTurn = (id: string) => app.post(`/saves/${id}/turns`, { input: "I wait." });
const lastSystem = () => prompts.at(-1)!.findLast(({ role }) => role === "system")!.content as string;

test("each finished Turn's summary becomes the story's", async () => {
  play(summed("Ash reached the docks."), summed("Ash left the docks."));
  const id = await app.createSave();

  await playTurn(id);
  expect(await summaryOf(id)).toBe("Ash reached the docks.");
  await playTurn(id);

  expect(await summaryOf(id)).toBe("Ash left the docks.");
});

test("the summary is asked for every few replies, and again until one comes, in the tail, so the cached start never changes", async () => {
  // Written in the first reply only, so the one due a round later doesn't come and is asked for again.
  const turns = SUMMARY_EVERY + 2;
  play(summed("Ash reached the docks."), ...Array.from({ length: turns - 1 }, () => summed("")));
  const id = await app.createSave();

  const due: boolean[] = [];
  for (let turn = 0; turn < turns; turn++) {
    await playTurn(id);
    due.push(lastSystem().includes("The summary is due in this Turn."));
  }

  expect(due).toEqual(Array.from({ length: turns }, (_, turn) => turn === 0 || turn >= SUMMARY_EVERY));
  expect(new Set(prompts.map((prompt) => prompt[0]!.content)).size).toBe(1);
});

test("each finished Turn's recent_summary becomes the Journal's recent summary, and a blank one keeps the last", async () => {
  const recent = (text: string | null) =>
    JSON.stringify({ check: null, narration: "Rain.", state_operations: [], summary: "All of it.", recent_summary: text });
  play(recent("Ash reached the docks."), recent(null));
  const id = await app.createSave();
  const journal = async () => (await app.get(`/saves/${id}/journal`).then((r) => r.json())) as { summary: string; recentSummary: string };

  await playTurn(id);
  expect(await journal()).toMatchObject({ summary: "All of it.", recentSummary: "Ash reached the docks." });
  await playTurn(id);

  expect((await journal()).recentSummary).toBe("Ash reached the docks.");
  expect(lastSystem()).not.toContain("recentSummary");
});

test("a summary cut to a fraction of the last, as a placeholder such as '(see journal)', keeps the last; a shorter real one is taken", async () => {
  const long = "Ash reached the docks at dusk, met the ferryman, learned the tide tables were forged, and followed the forger to the old customs house.";
  const turn = (summary: string) => JSON.stringify({ check: null, narration: "Rain.", state_operations: [], summary, recent_summary: null });
  play(turn(long), turn("(see journal)"), turn("Ash followed the forger to the customs house and found the false tables."));
  const id = await app.createSave();
  const summary = async () => ((await app.get(`/saves/${id}/journal`).then((r) => r.json())) as { summary: string }).summary;

  await playTurn(id);
  await playTurn(id);
  expect(await summary()).toBe(long);
  await playTurn(id);

  expect(await summary()).toBe("Ash followed the forger to the customs house and found the false tables.");
});

for (const [label, missing] of [
  ["blank", "  "],
  ["malformed", 7],
  ["null", null],
] as const) {
  test(`a ${label} summary leaves the story's as it was, and doesn't cost the Turn`, async () => {
    play(summed("Ash reached the docks."), summed(missing));
    const id = await app.createSave();
    await playTurn(id);

    const response = await playTurn(id);

    expect(response.status).toBe(201);
    expect(await summaryOf(id)).toBe("Ash reached the docks.");
  });
}

test("the summary has one way in, its field, as a second one in state_operations was what a looping model repeated", async () => {
  play(narration("Rain."));
  const id = await app.createSave();

  await playTurn(id);

  expect(JSON.stringify(prompts)).toContain('\\"summary\\"');
  expect(JSON.stringify(prompts)).not.toContain("set_summary");
});

test("the last word before the player's action keeps the PC's choices theirs and their thoughts private", async () => {
  play(narration("Rain."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toContain("The player alone decides what the PC says, chooses and does");
  expect(lastSystem()).toContain("private thought");
});

test("Plot Threads come forward at the Narrator's choice of a pause, by a rule in the cached start, never by the clock", async () => {
  play(...Array(9).fill(narration("Rain.")));
  const id = await app.createSave();
  const saves = saveStore(join(folder.path, "Saves"));
  saves.commitTurn(id, saves.latestMessageId(id), "I look around.", "Rain falls.", undefined, (state) => ({ ...state, plotThreads: ["THREAD-ONE"] }));

  for (let turn = 0; turn < 9; turn++) await playTurn(id);

  expect(prompts.at(-1)![0]!.content).toContain("At a natural pause in the story");
  expect(JSON.stringify(prompts.at(-1))).toContain("THREAD-ONE");
  expect(lastSystem()).not.toContain("THREAD-ONE");
});

test("the Narrator may invent the present but not the PC's past, and that rule leaves the cached start alone", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toContain("Invent freely in the present");
  expect(lastSystem()).toContain("something the PC did, said or was told earlier");
  expect(prompts.at(-1)![0]!.content).not.toContain("Invent freely");
});

test("the Narrator stops when someone waits on the PC, and that rule leaves the cached start alone", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toContain("End the reply there");
  expect(lastSystem()).toContain("the PC's time passes only when the player says so");
  expect(prompts.at(-1)![0]!.content).not.toContain("End the reply there");
});

test("the rules every story needs are built in, near the reply, so Model Instructions can stay short", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  for (const rule of [
    "People know only what they have seen, heard or been told themselves",
    "Carry on from the last reply",
    "Their goals are their own and can conflict with the PC's",
    "Avoid melodrama, cliché and overused metaphors",
    "rather than participle phrases",
    "Vary the length and structure of your sentences",
    "Never use em-dashes",
    "in the narration and in anyone's speech: never set it against something it isn't",
  ]) {
    expect(lastSystem()).toContain(rule);
    expect(prompts.at(-1)![0]!.content).not.toContain(rule);
  }
  expect(prompts.at(-1)![0]!.content).toContain("Where the PC is somewhere a Plot Thread's now would show, it shows in passing");
});

test("the pace of a reply, then what's true right now, are the last things the Narrator reads before the player's words", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toMatch(
    /never carry it through to its end in one reply\.\nRight now, from the current state: \{"inventory":.*"scene":.*"storyTime":.*\}$/,
  );
  expect(lastSystem()).not.toMatch(/Current state[^\n]*"inventory"/);
  expect(lastSystem()).toContain("never over 350");
  expect(prompts.at(-1)!.at(-1)!.role).toBe("user");
});

test("a reply is held to one thing for the PC to answer, in numbers the Narrator can count", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toContain("Each person speaks once in a reply, and no one speaks more than three times.");
  expect(lastSystem()).toContain("at most one thing for the PC to answer");
});

test("no one echoes the PC, re-argues a case the PC turned down, or ends most replies on a choice of two", async () => {
  play(summed("Ash reached the docks."));
  const id = await app.createSave();

  await playTurn(id);

  expect(lastSystem()).toContain("no one opens by echoing what the PC just said");
  // Nor a line the replies above already gave, word for word, as a confession was told again to a newcomer as it was.
  expect(lastSystem()).toContain("never have anyone say again word for word what was said in them");
  expect(lastSystem()).toContain("that person doesn't raise it again unless something new gives them reason");
  expect(lastSystem()).toContain("once the PC has said there's time, no one asks how long is left or counts it down");
  expect(lastSystem()).toContain("they don't all argue for the same view");
  expect(lastSystem()).toContain("few replies should end on a choice between two things");
  expect(
    prompts
      .at(-1)!
      .map(({ content }) => content)
      .join("\n"),
  ).toContain("[Voice in the light] for someone not yet named");
  expect(
    prompts
      .at(-1)!
      .map(({ content }) => content)
      .join("\n"),
  ).toContain("with its colours and materials, and name each garment by its period form");
});

test("a reply that still sends the retired set_summary is kept, with its summary field", async () => {
  play(JSON.stringify({ check: null, narration: "Rain.", state_operations: [{ op: "set_summary", summary: "An older idea." }], summary: "It rained." }));
  const id = await app.createSave();

  expect((await playTurn(id)).status).toBe(201);

  expect(await summaryOf(id)).toBe("It rained.");
  expect(prompts).toHaveLength(1);
});
