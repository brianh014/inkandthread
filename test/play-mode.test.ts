import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import type { TextProvider } from "../src/turn-engine";
import { logOf, narration, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let app: ReturnType<typeof startApp> | undefined;

const CHOICES = ["I wade on.", "I call for help.", "I climb the wall."];
const withChoices = (text: string, choices: unknown = CHOICES) => JSON.stringify({ narration: text, state_operations: [], choices });

const play = (...replies: (string | Error)[]) => {
  const script = scriptedTextProvider(...replies);
  app = startApp(savesDir, script.textProvider);
  return { app, ...script };
};

/** A Save in Choices mode with one Turn played. */
async function choosing(...replies: string[]) {
  const script = play(withChoices("The tide rises."), ...replies);
  const id = await script.app.createSave();
  await script.app.patch(`/saves/${id}`, { playMode: "choices" });
  const turn = await script.app.post(`/saves/${id}/turns`, { input: "I wade forward." }).then((r) => r.json());
  return { ...script, id, turn };
}

const latestChoices = (id: string) => app!.get(`/saves/${id}/messages`).then(async (r) => ((await r.json()) as { choices?: string[] }).choices);
const schemaKeys = (schema: unknown) => Object.keys((schema as { properties: object }).properties);

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});

afterEach(async () => {
  await app?.stop();
  folder.remove();
});

test("a Save starts in Free Text, whose Narrator is asked for no Choices and whose responses store none", async () => {
  const { app, schemas, prompts } = play(narration("The tide rises."));
  const id = await app.createSave();

  expect(await app.get(`/saves/${id}`).then((r) => r.json())).toMatchObject({ playMode: "free" });
  await app.post(`/saves/${id}/turns`, { input: "I wade forward." });

  expect(schemaKeys(schemas[0])).not.toContain("choices");
  expect(JSON.stringify(prompts[0])).not.toContain("choices");
  expect(await latestChoices(id)).toBeUndefined();
});

test("in Choices mode a response keeps its three Choices, sent last in the schema and with the Messages", async () => {
  const { id, turn, schemas } = await choosing();

  expect(schemaKeys(schemas[0]).at(-1)).toBe("choices");
  expect(turn.messages.at(-1)).toMatchObject({ role: "narrator", text: "The tide rises.", choices: CHOICES });
  expect(await latestChoices(id)).toEqual(CHOICES);
  expect(await app!.get(`/saves/${id}`).then((r) => r.json())).toMatchObject({ playMode: "choices" });
});

test("a Choice that names the PC, written as someone else, is dropped and the others kept", async () => {
  const script = play(withChoices("The tide rises.", ["I wade on.", "I crouch beside Ash and tell him to keep still.", "I climb the wall."]));
  const id = await script.app.createSave();
  await script.app.patch(`/saves/${id}`, { playMode: "choices" });

  const log = await logOf(() => script.app.post(`/saves/${id}/turns`, { input: "I wade forward." }), "info");

  expect(await latestChoices(id)).toEqual(["I wade on.", "I climb the wall."]);
  expect(log).toContain("Choices naming the PC dropped");
});

test("switching to Free Text and back keeps the latest Choices, and the next Turn ends them", async () => {
  const { id } = await choosing(narration("The wall holds."));

  await app!.patch(`/saves/${id}`, { playMode: "free" });
  expect(await latestChoices(id)).toEqual(CHOICES);
  await app!.patch(`/saves/${id}`, { playMode: "choices" });
  expect(await latestChoices(id)).toEqual(CHOICES);

  await app!.patch(`/saves/${id}`, { playMode: "free" });
  await app!.post(`/saves/${id}/turns`, { input: "I climb." });
  expect(await latestChoices(id)).toBeUndefined();
});

test("a reply without three different Choices keeps its story, and the Choices are asked for alone", async () => {
  const { id, prompts } = await choosing(narration("Missing."), JSON.stringify({ choices: ["I run."] }), JSON.stringify({ choices: CHOICES }));

  const response = await app!.post(`/saves/${id}/turns`, { input: "I look around." });

  expect(response.status).toBe(201);
  expect(prompts).toHaveLength(4);
  // With the player's move as well as the reply, as Choices written from the reply alone were the weakest of a run.
  expect(prompts[2]!.at(-1)!.content).toContain("I look around.");
  expect(((await response.json()) as { messages: object[] }).messages.at(-1)).toMatchObject({ role: "narrator", text: "Missing." });
  expect(await latestChoices(id)).toEqual(CHOICES);
});

test("when fewer than two Choices are left once those built on the unknown are dropped, the Choices are asked for alone", async () => {
  // The reviewer can't write the leaking ones again, and answers State Upkeep with nothing.
  const reviewer: TextProvider = async (prompt) => {
    if (prompt[0]!.content.includes("unknown_words")) throw new Error("down");
    return JSON.stringify({ state_operations: [] });
  };
  const script = scriptedTextProvider(
    withChoices("The tide rises.", ["I ride for Qasr.", "I ask Zorel the way.", "I wade on."]),
    JSON.stringify({ choices: CHOICES }),
  );
  app = startApp(savesDir, script.textProvider, undefined, undefined, undefined, undefined, undefined, reviewer);
  const id = await app.createSave();
  await app.patch(`/saves/${id}`, { playMode: "choices" });

  const log = await logOf(() => app!.post(`/saves/${id}/turns`, { input: "I wade forward." }), "info");

  expect(script.prompts).toHaveLength(2);
  expect(await latestChoices(id)).toEqual(CHOICES);
  expect(log).toContain('Too few Choices kept {"route":"/saves/:id/turns","save":"');
});

test("a Turn whose Choices can't be written alone is kept without any", async () => {
  const repeated = JSON.stringify({ choices: ["I run.", "I run.", " I run. "] });
  const { id, prompts } = await choosing(withChoices("Repeated.", ["next", "next2", "next3"]), repeated, repeated, repeated);

  expect((await app!.post(`/saves/${id}/turns`, { input: "I look around." })).status).toBe(201);

  expect(prompts).toHaveLength(5);
  expect(await latestChoices(id)).toBeUndefined();
});

test("Regenerate, Rewrite and Edit each write new Choices", async () => {
  const fresh = (n: number) => CHOICES.map((choice) => `${choice} ${n}`);
  const { id } = await choosing(withChoices("Again.", fresh(1)), withChoices("Rewritten.", fresh(2)), withChoices("ignored", fresh(3)));

  await app!.post(`/saves/${id}/messages/2/regenerate`, {});
  expect(await latestChoices(id)).toEqual(fresh(1));
  await app!.post(`/saves/${id}/messages/3/rewrite`, { feedback: "Make it stormy." });
  expect(await latestChoices(id)).toEqual(fresh(2));
  await app!.post(`/saves/${id}/messages/4/edit`, { text: "The storm breaks." });
  expect(await latestChoices(id)).toEqual(fresh(3));
});

test("Choices go with a Save through export and import", async () => {
  const { id } = await choosing();
  const saves = saveStore(savesDir);

  const copy = saves.import(new Uint8Array(saves.export(id)));

  expect(saves.latestChoices(copy)).toEqual(CHOICES);
  expect(saves.read(copy).playMode).toBe("choices");
});

test("a Play Mode that isn't Free Text or Choices is refused", async () => {
  const { app } = play();
  const id = await app.createSave();

  expect((await app.patch(`/saves/${id}`, { playMode: "auto" })).status).toBe(400);
});

test("the log names which Choice was picked by number, and only Story in log shows the Choices' words", async () => {
  const { id } = await choosing(withChoices("The wall holds."), withChoices("The rope frays."));

  const quiet = await logOf(() => app!.post(`/saves/${id}/turns`, { input: CHOICES[1] }), "info");
  expect(quiet).toContain('Choice picked {"route":"/saves/:id/turns","save":"');
  expect(quiet).toContain('"choice":2}');
  expect(quiet).not.toContain(CHOICES[0]!);

  await app!.patch("/settings", { storyInLog: true });
  const told = await logOf(() => app!.post(`/saves/${id}/turns`, { input: "I shout at the tide." }), "info");
  expect(told).toContain('"choice":"own words"');
  expect(told).toContain(`Choices offered {"route":"/saves/:id/turns","save":"${id}","choices":${JSON.stringify(CHOICES)}}`);
});
