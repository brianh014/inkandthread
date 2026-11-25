import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { duePlan, forgetOffers, planOffered, planShown } from "../src/due-plans";
import { saveStore } from "../src/save-store";
import { openingState, type State } from "../src/state-applier";
import { logOf, narration, scriptedTextProvider, startApp, tempFolder } from "./support";

const DREM = "The wells mean to buy Tamsin.";
const OSSERY = "Ossery cut the skins.";
const PLAN = "At seven Drem will thrust the sealed packet into Tamsin's hand.";
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
    [DREM]: PLAN,
  },
  threadsDue: { [OSSERY]: 19, [DREM]: 19 },
  scene: { location: "the mouth of the gap", visibleCast: ["Tamsin"] },
  storyTime: at(18.95),
};

test("the plan brought on is one near the PC whose hour this reply reaches, never a far one", () => {
  expect(duePlan("near", state, "Wren")).toBe(PLAN);
  // Not before its hour is in reach, but after it while no move has told it.
  expect(duePlan("early", { ...state, storyTime: at(18.6) }, "Wren")).toBeUndefined();
  expect(duePlan("pace", { ...state, storyTime: at(18.6) }, "Wren", 0.5)).toBe(PLAN);
  expect(duePlan("late", { ...state, storyTime: at(29) }, "Wren")).toBe(PLAN);
  // Nor missed by a rounding, or by a pace shorter than a reply may take.
  expect(duePlan("rounding", { ...state, storyTime: at(18.949999999999974) }, "Wren", 0.05)).toBe(PLAN);
  // Someone with the PC, the PC by name, or the PC's place makes it near, and otherwise none is sent.
  const alone = { ...state, scene: { location: "the north pillar", visibleCast: [] } };
  const plan = (text: string, hours = 18.95, pace = 0.1) =>
    duePlan("alone", { ...alone, storyTime: at(hours), threadsPlan: { [DREM]: text } }, "Mara Vell", pace);
  expect(plan(PLAN)).toBeUndefined();
  expect(plan("At seven Drem will tell Mara.")).toContain("Mara");
  expect(plan("At seven Drem will tell Mrs Vell.")).toContain("Vell");
  expect(plan("At seven Drem will climb the pillar.")).toContain("pillar");
  // By what someone in view with no name is called.
  const watched = { ...alone, scene: { ...alone.scene, visibleCast: ["Rider on the crest"] }, storyTime: at(19) };
  expect(duePlan("called", { ...watched, threadsPlan: { [DREM]: "At seven the rider will demand the satchel." } }, "Wren")).toContain("rider");
  // Never by whom a far deed is meant for.
  expect(plan("At seven Ossery will bury his knife, meaning to meet Mara.")).toBeUndefined();
  // Never by a surname shared, a direction or any room, nor hours ahead at a pace of travel.
  expect(plan("At seven Jon Vell will burn the papers in Harrow.")).toBeUndefined();
  expect(plan("At seven Drem will carry the lie north.")).toBeUndefined();
  expect(plan("At seven Drem will tell Mara.", 13, 6)).toBeUndefined();
});

test("a plan is offered to two committed Turns at most, a replacement aside, and afresh once a Revert takes them", () => {
  planOffered("twice", PLAN);
  expect(duePlan("twice", state, "Wren")).toBe(PLAN);
  planOffered("twice", PLAN);
  expect(duePlan("twice", state, "Wren")).toBeUndefined();
  expect(duePlan("twice", state, "Wren", 0.1, true)).toBe(PLAN);
  forgetOffers("twice");
  expect(duePlan("twice", state, "Wren")).toBe(PLAN);
});

test("a plan is shown by its doer coming into view or speaking, or by the deed told, and never by a mention of them", () => {
  const there = { ...state, scene: { ...state.scene, visibleCast: ["Tamsin", "Drem"] } };
  const seen = (narration: string, after = state, before = state) => planShown(PLAN, before, after, narration);
  // Told as it looks, in none of the plan's words.
  expect(seen("Drem bent close, and something pale passed from his hand to hers.", there)).toBe(true);
  expect(seen("[Drem]: “To Kesh, whole.”")).toBe(true);
  expect(seen("[Tamsin]: “Has Drem been by?”")).toBe(false);
  // Someone the PC doesn't know may do it unnamed.
  expect(seen("A hooded man thrust a sealed packet at her.")).toBe(true);
  expect(seen("Drem sat by his donkey.", there, there)).toBe(false);
  expect(seen("Drem wrenched free and thrust a sealed packet at her.", there, there)).toBe(true);
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
