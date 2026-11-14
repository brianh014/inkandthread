import { expect, test } from "bun:test";
import { join } from "node:path";
import { assemblePrompt } from "../src/prompt-assembler";
import { saveStore } from "../src/save-store";
import { tempFolder } from "./support";
import { applyEdit, applyOperations, openingState, type State, type StateOperation } from "../src/state-applier";

const at = (storyTime: State["storyTime"]) => ({ ...structuredClone(openingState), storyTime });
const set = (days_passed: number, date: string | null, time_of_day: string): StateOperation => ({ op: "set_story_time", days_passed, date, time_of_day });
const DUSK = { day: 3, date: "3rd of Lowtide", timeOfDay: "dusk" };

test("time passing within a day keeps the date and the day count", () => {
  expect(applyOperations(at(DUSK), [set(0, null, "night")]).next.storyTime).toEqual({ ...DUSK, timeOfDay: "night" });
});

test("days passing add to the day count, with the new date the Narrator worked out", () => {
  expect(applyOperations(at(DUSK), [set(2, "5th of Lowtide", "dawn")]).next.storyTime).toEqual({ day: 5, date: "5th of Lowtide", timeOfDay: "dawn" });
});

test("a new day with no date, or a first Story Time with none, is ignored and changes nothing", () => {
  for (const [state, operation] of [
    [at(DUSK), set(1, null, "dawn")],
    [at(null), set(0, null, "dawn")],
  ] as const) {
    const { next, refused, ignored } = applyOperations(state, [operation]);
    expect(next.storyTime).toEqual(state.storyTime);
    expect(refused).toEqual([]);
    expect(ignored).toEqual([{ op: "set_story_time", reason: "no date" }]);
  }
});

test("a Save from before Story Time starts counting from day 1", () => {
  expect(applyOperations(at(null), [set(0, "3rd of Lowtide", "dusk")]).next.storyTime).toEqual({ day: 1, date: "3rd of Lowtide", timeOfDay: "dusk" });
});

test("the player's edit changes the date and time of day, never the day count", () => {
  expect(applyEdit(at(DUSK), { edit: "storyTime", date: "9th of Lowtide", timeOfDay: "noon" }).storyTime).toEqual({
    day: 3,
    date: "9th of Lowtide",
    timeOfDay: "noon",
  });
});

const prompt = (storyTime: State["storyTime"], played: boolean) =>
  assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: at(storyTime),
    messages: played
      ? [
          { id: 1, role: "player", text: "I wait." },
          { id: 2, role: "narrator", text: "Rain." },
        ]
      : [],
    modelInstructions: "",
    input: "I wait.",
    responseSchema: "{}",
    promptStyle: null,
  })
    .map(({ content }) => content)
    .join("\n");

test("the Narrator is asked to set a missing Story Time only in a story already under way", () => {
  expect(prompt(null, true)).toContain("storyTime is null, so set it now");
  expect(prompt(null, false)).not.toContain("storyTime is null");
  expect(prompt(DUSK, true)).not.toContain("storyTime is null");
  expect(prompt(DUSK, true)).toContain('"storyTime":{"day":3,"date":"3rd of Lowtide","timeOfDay":"dusk"}');
});

test("each Scene Memory opens with the Story Time its scene began at, and one from before Story Time has none", () => {
  const text = assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: {
      ...at(DUSK),
      sceneMemories: [
        { firstMessage: 1, lastMessage: 4, text: "Ash met Hesper." },
        { firstMessage: 5, lastMessage: 8, text: "Ash crossed the bay." },
      ],
    },
    messages: [],
    memoryTimes: { 5: "3rd of Lowtide, dusk" },
    modelInstructions: "",
    input: "I wait.",
    responseSchema: "{}",
    promptStyle: null,
  })
    .map(({ content }) => content)
    .join("\n");

  expect(text).toContain(JSON.stringify(["Ash met Hesper.", "3rd of Lowtide, dusk: Ash crossed the bay."]));
  expect(text).toContain("to the date and time the Scene Memory of it opens with, never a guess");
});

test("a memory is dated from the Story Time just before its first Message, as that Message's Turn may move time on", () => {
  const folder = tempFolder();
  const saves = saveStore(join(folder.path, "Saves"));
  const id = saves.create({ worldBrief: "A drowned city", pc: { name: "Ash" } });
  const play = (storyTime: State["storyTime"]) =>
    saves.commitTurn(id, saves.latestMessageId(id), "I wait.", "Rain.", undefined, (state) => ({ ...state, storyTime }));
  play(null);
  play(DUSK);
  play({ day: 4, date: "4th of Lowtide", timeOfDay: "dawn" });

  // 4 is the reply that set dusk, and 6 the one that moved on to dawn.
  expect(saves.storyTimesAt(id, [1, 4, 5, 6])).toEqual({ 5: "3rd of Lowtide, dusk", 6: "3rd of Lowtide, dusk" });
  folder.remove();
});

test("people are asked to stay true to what they said they intend, time included, and to record it", () => {
  const text = prompt(DUSK, true);

  expect(text).toContain("People stay true to what they have said they intend, such as how long they can stay");
  expect(text).toContain("Record an intention that will matter later with add_known_fact");
});
