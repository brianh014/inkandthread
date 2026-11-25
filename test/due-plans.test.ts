import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { duePlan, planShown } from "../src/due-plans";
import { saveStore } from "../src/save-store";
import { openingState, type State } from "../src/state-applier";
import { logOf, narration, scriptedTextProvider, startApp, tempFolder } from "./support";

const DREM = "The wells mean to buy Tamsin.";
const OSSERY = "Ossery cut the skins.";
const at = (hours: number) => ({ day: 1, date: "1st of Thaw", timeOfDay: "evening", hours });
const state: State = {
  ...openingState,
  npcs: [
    { name: "Drem", appearance: "a pedlar" },
    { name: "Tamsin", appearance: "a drover" },
    { name: "Ossery", appearance: "a keeper" },
  ],
  plotThreads: [OSSERY, DREM],
  threadsPlan: {
    [OSSERY]: "At seven Ossery will bury the coin under his floor stone.",
    [DREM]: "At seven Drem will thrust the sealed packet into Tamsin's hand.",
  },
  threadsDue: { [OSSERY]: 19, [DREM]: 19 },
  scene: { location: "the mouth of the gap", visibleCast: ["Tamsin"] },
  storyTime: at(18.95),
};

test("the plan brought on is one near the PC whose hour this reply reaches, never a far one", () => {
  expect(duePlan("near", state, "Wren")?.truth).toBe(DREM);
  // Not before its hour is in reach, nor long after it.
  expect(duePlan("early", { ...state, storyTime: at(18.5) }, "Wren")).toBeUndefined();
  expect(duePlan("pace", { ...state, storyTime: at(18.5) }, "Wren", 0.5)?.truth).toBe(DREM);
  expect(duePlan("late", { ...state, storyTime: at(19.6) }, "Wren")).toBeUndefined();
  // Someone with the PC, the PC by name, or the PC's place makes it near, and otherwise none is sent. A direction is no place.
  const alone = { ...state, scene: { location: "the north rock", visibleCast: [] } };
  expect(duePlan("alone", alone, "Wren")).toBeUndefined();
  expect(duePlan("direction", { ...alone, threadsPlan: { [DREM]: "At seven Drem will carry the lie north." } }, "Wren")).toBeUndefined();
  expect(duePlan("named", { ...alone, threadsPlan: { [DREM]: "At seven Drem will call Wren out." } }, "Wren")?.truth).toBe(DREM);
  expect(duePlan("place", { ...alone, threadsPlan: { [DREM]: "At seven Drem will carry it north, and climb the rock." } }, "Wren")?.truth).toBe(DREM);
});

test("a plan is offered to two replies at most, so one the Narrator leaves out goes to the next move", () => {
  const offers = [1, 2, 3].map(() => duePlan("twice", state, "Wren"));
  expect(offers.map((offer) => offer?.truth)).toEqual([DREM, DREM, undefined]);
});

test("a plan is shown by a reply that brings on its doer, or has one already there do it by two of its own words", () => {
  const plan = state.threadsPlan[DREM]!;
  // Told as it looks, in none of the plan's words.
  expect(planShown(plan, state, "Drem bent close, and something pale passed from his hand to hers.")).toBe(true);
  expect(planShown(plan, state, "A man thrust a sealed packet at her.")).toBe(false);
  const there = { ...state, scene: { ...state.scene, visibleCast: ["Tamsin", "Drem"] } };
  expect(planShown(plan, there, "Drem sat by his donkey.")).toBe(false);
  expect(planShown(plan, there, "Drem wrenched free and thrust a sealed packet at her.")).toBe(true);
});

let folder: ReturnType<typeof tempFolder>;
beforeEach(() => {
  folder = tempFolder();
});
afterEach(() => folder.remove());

test("the Turn whose hour a near plan comes in is asked to bring it on, and a plan it played goes", async () => {
  const script = scriptedTextProvider(
    narration("Drem wrenched free of the guards and thrust a sealed packet at Tamsin."),
    narration("The rider walks off.", { op: "set_story_time", days_passed: 0, hours_passed: 0.1, time_of_day: "evening", date: null }),
  );
  const app = startApp(join(folder.path, "Saves"), script.textProvider);
  const saves = saveStore(join(folder.path, "Saves"));
  const opening = {
    npcs: state.npcs,
    plotThreads: state.plotThreads,
    threadsPlan: state.threadsPlan,
    threadsDue: state.threadsDue,
    scene: state.scene,
    storyTime: state.storyTime,
  };
  const id = saves.create({ worldBrief: "A road", pc: { name: "Wren" }, opening });

  const log = await logOf(async () => {
    expect((await app.post(`/saves/${id}/turns`, { input: "I walk to the gap." })).status).toBe(201);
    expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);
  }, "info");

  const sent = (at: number) => script.prompts[at]!.map(({ content }) => content).join(" ");
  expect(sent(0)).toContain(`Due now, out of the PC's sight so far: ${JSON.stringify(state.threadsPlan[DREM])}`);
  expect(sent(0)).toContain("never in place of it");
  expect(sent(1)).not.toContain("Due now, out of the PC's sight");
  expect(saves.latestState(id).threadsPlan).toEqual({ [OSSERY]: state.threadsPlan[OSSERY]! });
  expect(log).toContain("Due plan offered {");
  expect(log).toContain('"planOffered":1,"plansShown":1');
  await app.stop();
});
