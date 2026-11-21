import { expect, test } from "bun:test";
import { join } from "node:path";
import { assemblePrompt } from "../src/prompt-assembler";
import { saveStore } from "../src/save-store";
import { tempFolder } from "./support";
import { applyEdit, applyOperations, openingState, type State, type StateOperation } from "../src/state-applier";

const at = (storyTime: State["storyTime"]) => ({ ...structuredClone(openingState), storyTime });
const set = (days_passed: number, date: string | null, time_of_day: string, hours_passed: number | null = null): StateOperation => ({
  op: "set_story_time",
  days_passed,
  hours_passed,
  date,
  time_of_day,
});
const DUSK = { day: 3, date: "3rd of Lowtide", timeOfDay: "dusk" };

test("time passing within a day keeps the date and the day count", () => {
  expect(applyOperations(at(DUSK), [set(0, null, "night")]).next.storyTime).toMatchObject({ ...DUSK, timeOfDay: "night" });
});

test("days passing add to the day count, with the new date the Narrator worked out", () => {
  expect(applyOperations(at(DUSK), [set(2, "5th of Lowtide", "dawn")]).next.storyTime).toMatchObject({ day: 5, date: "5th of Lowtide", timeOfDay: "dawn" });
});

test("days passing on the same date count no days, as models gave the day count as days_passed and doubled it", () => {
  expect(applyOperations(at(DUSK), [set(3, "3rd of Lowtide", "night")]).next.storyTime).toMatchObject({ ...DUSK, timeOfDay: "night" });
});

test("a first Story Time with no date is ignored and changes nothing", () => {
  const { next, refused, ignored } = applyOperations(at(null), [set(0, null, "dawn")]);
  expect(next.storyTime).toBeNull();
  expect(refused).toEqual([]);
  expect(ignored).toEqual([{ op: "set_story_time", reason: "no date" }]);
});

test("a new day with no date, or hours past midnight, moves the day on and keeps the date until a Turn names the new one", () => {
  // Day 3 at dusk is hour 66 on the clock.
  expect(applyOperations(at(DUSK), [set(1, null, "dawn")]).next.storyTime).toMatchObject({ day: 4, date: DUSK.date, dateDue: true });
  const small = applyOperations(at({ ...DUSK, timeOfDay: "ten at night", hours: 70 }), [set(0, null, "three in the morning", 5)]).next;
  expect(small.storyTime).toMatchObject({ day: 4, date: DUSK.date, hours: 75, dateDue: true });
  expect(prompt(small.storyTime, true)).toContain("storyTime has passed midnight into a new day");
  // The date, when it comes, counts no second day.
  const dated = applyOperations(small, [set(1, "4th of Lowtide", "dawn", 3)]).next.storyTime;
  expect(dated).toEqual({ day: 4, date: "4th of Lowtide", timeOfDay: "dawn", hours: 78 });
});

test("a time of day that repeats the date keeps only the time", () => {
  const date = "Tuesday, 16th October 1894";
  expect(applyOperations(at(DUSK), [set(1, date, "mid-morning, Tuesday 16th October")]).next.storyTime?.timeOfDay).toBe("mid-morning");
  expect(applyOperations(at(DUSK), [set(1, date, "Tuesday morning")]).next.storyTime?.timeOfDay).toBe("Tuesday morning");
});

test("time moving back within the same day is ignored, as a reply that did so had started the story again", () => {
  const evening = at({ ...DUSK, timeOfDay: "early evening" });
  for (const operation of [set(0, null, "mid-morning"), set(0, "3rd of Lowtide", "late afternoon")]) {
    const { next, ignored } = applyOperations(evening, [operation]);
    expect(next.storyTime).toEqual(evening.storyTime);
    expect(ignored).toEqual([{ op: "set_story_time", reason: "earlier than now" }]);
  }
  for (const [from, to] of [
    ["late afternoon", "ten past eight at night"],
    ["night", "midnight"],
    ["dawn", "mid-morning"],
    ["morning", "afternoon"],
  ]) {
    expect(applyOperations(at({ ...DUSK, timeOfDay: from! }), [set(0, null, to!)]).next.storyTime?.timeOfDay).toBe(to!);
  }
  expect(applyOperations(evening, [set(1, "4th of Lowtide", "mid-morning")]).next.storyTime?.timeOfDay).toBe("mid-morning");
});

test("past midnight on the same date, the small hours and the next morning still count as later", () => {
  for (const [from, to] of [
    ["past midnight", "the small hours of Monday night"],
    ["past midnight", "near two of the morning"],
    ["the small hours of Monday night", "first light on Tuesday morning"],
  ]) {
    expect(applyOperations(at({ ...DUSK, timeOfDay: from! }), [set(0, null, to!)]).next.storyTime?.timeOfDay).toBe(to!);
  }
  expect(applyOperations(at({ ...DUSK, timeOfDay: "past midnight" }), [set(0, null, "late afternoon")]).ignored).toHaveLength(1);
});

test("a Save from before Story Time starts counting from day 1", () => {
  expect(applyOperations(at(null), [set(0, "3rd of Lowtide", "dusk")]).next.storyTime).toMatchObject({ day: 1, date: "3rd of Lowtide", timeOfDay: "dusk" });
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
  expect(text).toContain(
    "Record an intention that will matter later, and what the PC is told of where someone out of sight is and what they are doing, with add_known_fact",
  );
});

test("the clock adds each reply's hours_passed, or the hours its words moved on, and never falls short of the days passed", () => {
  const clock = (state: State, operation: StateOperation) => applyOperations(state, [operation]).next.storyTime?.hours;
  // From a Save without one, its day and time of day: day 3 at dusk is 66.
  expect(clock(at(DUSK), set(0, null, "night", 2))).toBe(68);
  expect(clock(at(DUSK), set(0, null, "night"))).toBe(70);
  expect(clock(at({ ...DUSK, hours: 66 }), set(1, "4th of Lowtide", "the third bell", 1))).toBe(72);
  expect(clock(at({ ...DUSK, hours: 66 }), set(0, null, "the third bell", 0.5))).toBe(66.5);
  // A running total given as hours_passed moves it by the words instead.
  expect(clock(at({ ...DUSK, hours: 66 }), set(0, null, "night", 29.65))).toBe(70);
});
