import { expect, test } from "bun:test";
import { join } from "node:path";
import { assemblePrompt, withClock } from "../src/prompt-assembler";
import { saveStore } from "../src/save-store";
import { tempFolder } from "./support";
import { applyEdit, applyOperations, hourOf, openingState, type State, type StateOperation } from "../src/state-applier";

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

  expect(text).toContain("People stay true to what they have said, intend and feel");
  expect(text).toContain(
    "Record an intention that will matter later, and what the PC is told of where someone out of sight is and what they are doing, with add_known_fact",
  );
});

test("the clock adds each reply's hours_passed, or the hours its words moved on, and never falls short of the days passed", () => {
  const clock = (state: State, operation: StateOperation) => applyOperations(state, [operation]).next.storyTime?.hours;
  // From a Save without one, its day and time of day: day 3 at dusk is 66.
  expect(clock(at(DUSK), set(0, null, "night", 2))).toBe(68);
  expect(clock(at(DUSK), set(0, null, "night"))).toBe(70);
  expect(clock(at({ ...DUSK, hours: 66 }), set(1, "4th of Lowtide", "the third bell"))).toBe(72);
  expect(clock(at({ ...DUSK, hours: 66 }), set(0, null, "the third bell", 0.5))).toBe(66.5);
  // Hours that reach the new day keep their hour, as words for late night after midnight read as 10 pm put it a day on.
  expect(clock(at({ ...DUSK, hours: 66 }), set(1, "4th of Lowtide", "deep in the night", 8))).toBe(74);
  // A first Story Time is its own hour, whatever hours_passed says.
  expect(clock(at(null), set(0, "1st of Lowtide", "9 am", 8))).toBe(9);
  // Hours over-counted on talk never put an afternoon on the next day.
  const afternoon = applyOperations(at({ ...DUSK, timeOfDay: "afternoon", hours: 63 }), [set(0, null, "late afternoon", 12)]).next.storyTime;
  expect(afternoon).toMatchObject({ day: 3, hours: 75 });
  expect(afternoon).not.toHaveProperty("dateDue");
  // Set back to a clock time the words give when far from it, so an over-count never later rolls the day on words with no hour.
  const drifted = applyOperations(at({ day: 1, date: "1st of Lowtide", timeOfDay: "7 pm", hours: 19 }), [set(0, null, "8 pm", 20)]).next;
  expect(drifted.storyTime).toMatchObject({ day: 1, hours: 20 });
  expect(applyOperations(drifted, [set(0, null, "a little later")]).next.storyTime).toMatchObject({ day: 1, hours: 20 });
  // A running total given as hours_passed moves it by the words instead.
  expect(clock(at({ ...DUSK, hours: 66 }), set(0, null, "night", 29.65))).toBe(70);
});

test("a day the hours and words don't reach is refused, keeping the date, as a ten-yard walk was given the next day", () => {
  const dawn = at({ day: 1, date: "Tuesday, 6th June", timeOfDay: "a quarter to six in the morning", hours: 5.75 });
  const walk = applyOperations(dawn, [set(1, "Wednesday, 7th June", "a quarter past six in the morning", 0.25)]).next.storyTime;
  expect(walk).toMatchObject({ day: 1, date: "Tuesday, 6th June", hours: 6 });
  // A night slept through, or a reply that gives no hours, still moves the day on.
  expect(applyOperations(dawn, [set(1, "Wednesday, 7th June", "dawn", 24)]).next.storyTime).toMatchObject({ day: 2, date: "Wednesday, 7th June" });
  expect(applyOperations(dawn, [set(1, "Wednesday, 7th June", "dawn")]).next.storyTime).toMatchObject({ day: 2, date: "Wednesday, 7th June" });
});

test("a jump of two days or more with a new date is kept, though its hours don't reach a day", () => {
  const dawn = at({ day: 11, date: "Thursday, 25th October", timeOfDay: "dawn", hours: 240 });
  const saturday = applyOperations(dawn, [set(2, "Saturday, 27th October", "late morning", 5)]).next.storyTime;
  expect(saturday).toMatchObject({ day: 13, date: "Saturday, 27th October", timeOfDay: "late morning" });
  expect(saturday!.hours).toBeGreaterThan(12 * 24 + 6);
  // Not the day count given as days passed, a date written another way, or one gone back.
  for (const [days, date] of [
    [11, "Friday, 26th October"],
    [2, "Thursday 25 October"],
    [2, "Tuesday, 23rd October"],
  ] as const)
    expect(applyOperations(dawn, [set(days, date, "late morning", 5)]).next.storyTime).toMatchObject({ day: 11, date: "Thursday, 25th October" });
});

test("a clock time past midnight with no hours given moves the day on, and one going back within the day is refused", () => {
  const late = at({ day: 1, date: "1st of Lowtide", timeOfDay: "11 pm", hours: 23 });
  expect(applyOperations(late, [set(0, null, "1 am")]).next.storyTime).toMatchObject({ day: 2, hours: 25, dateDue: true });
  const afternoon = at({ day: 1, date: "1st of Lowtide", timeOfDay: "3 pm", hours: 15 });
  const back = applyOperations(afternoon, [set(0, null, "9 am")]);
  expect(back.next.storyTime).toEqual(afternoon.storyTime);
  expect(back.ignored).toEqual([{ op: "set_story_time", reason: "earlier than now" }]);
});

test("the Narrator reads storyTime's hours as the 24-hour time they reached, as it read its own noon back as past midnight", () => {
  expect(withClock({ day: 1, date: "6th June", timeOfDay: "a quarter past twelve", hours: 12.25 })).toEqual({
    day: 1,
    date: "6th June",
    timeOfDay: "a quarter past twelve",
    clock: "12:15",
  });
  expect(withClock({ day: 3, date: "8th June", timeOfDay: "dawn", hours: 53.999 })).toMatchObject({ clock: "06:00" });
  expect(withClock(DUSK)).toEqual(DUSK);
  expect(withClock(null)).toBeNull();
});

test("a time of day in words reads as its clock hour, as a clock reading only digits started the small hours at noon", () => {
  for (const [words, hour] of [
    ["four in the morning, full dark", 4],
    ["about half past five in the morning", 5.5],
    ["a quarter to twelve in the morning", 11.75],
    ["a quarter past twelve in the morning", 0.25],
    ["going on nine in the morning, still dark", 9],
    ["five minutes to nine in the morning", 8 + 55 / 60],
    ["a quarter past eight in the evening", 20.25],
    ["eleven at night", 23],
    ["two at night", 2],
    ["twelve in the afternoon", 12],
    ["small hours, dark", 2],
    ["the third bell", undefined],
  ] as const) {
    expect(hourOf(words)).toBe(hour);
  }
});

test("a night passed is a new day though the clock already ran past midnight with its words still before it", () => {
  const before = { ...openingState, storyTime: { day: 1, date: "Monday, 15th", timeOfDay: "a few minutes to midnight", hours: 24.05 } };
  const { next } = applyOperations(before, [
    { op: "set_story_time", days_passed: 1, hours_passed: 6.4, date: "Tuesday, 16th", time_of_day: "twenty past six in the morning" },
  ]);
  expect(next.storyTime).toMatchObject({ day: 2, date: "Tuesday, 16th", timeOfDay: "twenty past six in the morning" });
});

test("a short walk after talk over-counted past midnight is no new day, however the reply dates it", () => {
  const before = { ...openingState, storyTime: { day: 1, date: "Monday, 15th", timeOfDay: "evening", hours: 24.5 } };
  const { next } = applyOperations(before, [{ op: "set_story_time", days_passed: 1, hours_passed: 0.17, date: "Tuesday, 16th", time_of_day: "evening" }]);
  expect(next.storyTime).toMatchObject({ day: 1, date: "Monday, 15th" });
});

test("words that name the morning for an afternoon never set the clock back half a day, as noon became midnight", () => {
  const at = (timeOfDay: string, hours: number) => ({
    ...openingState,
    storyTime: { day: 1, date: "6th June", timeOfDay, hours },
  });
  const move = (hours_passed: number, time_of_day: string) => ({ op: "set_story_time" as const, days_passed: 0, hours_passed, time_of_day, date: null });
  const noon = applyOperations(at("about six minutes to twelve", 11.9), [move(0.75, "about a quarter to one in the morning")]).next;
  expect(noon.storyTime?.hours).toBeCloseTo(12.65);
  // Nor are the wrong words kept, as the next reply's hours would be told by them.
  const { next } = applyOperations(noon, [{ op: "set_story_time", days_passed: 0, hours_passed: null, time_of_day: "two in the afternoon", date: null }]);
  expect(next.storyTime).toMatchObject({ timeOfDay: "two in the afternoon" });
  expect(next.storyTime!.hours).toBeLessThan(15);
  // A night whose hours were over-counted is still set back to its morning.
  const night = applyOperations(at("five in the afternoon", 17), [
    { op: "set_story_time", days_passed: 1, hours_passed: 24, time_of_day: "six in the morning", date: "7th June" },
  ]).next;
  expect(night.storyTime).toMatchObject({ day: 2, hours: 30 });
  // Words a few hours off the count still set it, as it must never drift from what the page says.
  const drifted = applyOperations(at("a while later", 17), [move(0.1, "eleven in the morning")]).next;
  expect(drifted.storyTime?.hours).toBe(11);
});

test("a count a hair short of midnight rolls the day at words just past it, and one left behind rolls at the next small hour", () => {
  const night = at({ day: 2, date: "7th of Dry Month", timeOfDay: "late night", hours: 47.79999 });
  const past = applyOperations(night, [set(0, null, "just past midnight", 0.2)]).next.storyTime;
  expect(past).toMatchObject({ day: 3, dateDue: true });
  expect(past!.hours).toBeGreaterThanOrEqual(48);
  // A Save left a day behind by it.
  const behind = at({ day: 2, date: "7th of Dry Month", timeOfDay: "about half past midnight", hours: 48.55 });
  const one = applyOperations(behind, [set(0, null, "going on one in the morning", 0.3)]).next.storyTime;
  expect(one).toMatchObject({ day: 3 });
  expect(one!.hours).toBeCloseTo(48.85, 2);
  // Not a count run on past midnight while the words still say evening.
  const evening = at({ day: 1, date: "Monday, 15th", timeOfDay: "a little after ten at night", hours: 24.2 });
  expect(applyOperations(evening, [set(0, null, "half past ten at night", 0.2)]).next.storyTime).toMatchObject({ day: 1 });
});
