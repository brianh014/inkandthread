import { expect, test } from "bun:test";
import { howTheySpeak } from "../src/prompt-assembler";
import type { Message } from "../src/save-store";

const npcs = [
  { name: "Commander Devesh Rao", appearance: "small and precise" },
  { name: "Captain Ilse Vantor", appearance: "broad and grey-haired" },
  { name: "Lieutenant Hana Sorrell", appearance: "lean" },
];
const scene = { location: "The beach", visibleCast: ["Commander Devesh Rao", "Captain Ilse Vantor"] };
const narrator = (id: number, text: string): Message => ({ id, role: "narrator", text });

test("each person in view is heard in their earliest lines of six words or more, from before the Messages sent in full", () => {
  const messages: Message[] = [
    narrator(2, '[Commander Devesh Rao]: "Yes."\n[Devesh Rao]: "Ensign, you\'ll want the second drill, it\'s the one that saves you."'),
    { id: 3, role: "player", text: '[Rao]: "This is the player, never a line of his."' },
    narrator(
      4,
      '[Captain Ilse Vantor]: "Tell me what you think before you tell me what the manual says."\n[Lieutenant Hana Sorrell]: "The water here is warmer than the charts say it should be."',
    ),
    narrator(
      6,
      '[Commander Devesh Rao]: "I learn names in an hour, and I use them, every one of them."\n[Commander Devesh Rao]: "A third line that never comes, as two are enough."',
    ),
    narrator(8, '[Commander Devesh Rao]: "This one is sent in full already, so it is left out here."'),
  ];

  expect(howTheySpeak(messages, 8, { scene, npcs }, "", "Brian")).toEqual({
    // By a shortened name too, as Narrators shorten names.
    "Commander Devesh Rao": [
      "\"Ensign, you'll want the second drill, it's the one that saves you.\"",
      '"I learn names in an hour, and I use them, every one of them."',
    ],
    "Captain Ilse Vantor": ['"Tell me what you think before you tell me what the manual says."'],
  });
});

test("no one is heard who has no lines from before, and a long line is cut at a word", () => {
  const long = `"${"word ".repeat(60).trim()}."`;
  expect(howTheySpeak([narrator(2, '[Commander Devesh Rao]: "Later."')], 4, { scene, npcs }, "", "Brian")).toEqual({});
  const [line] = howTheySpeak([narrator(2, `[Captain Ilse Vantor]: ${long}`)], 4, { scene, npcs }, "", "Brian")["Captain Ilse Vantor"]!;
  expect(line!.length).toBeLessThanOrEqual(201);
  expect(line!.endsWith("word…")).toBe(true);
});

test("the PC's own lines are never taken for someone's voice, and a line with no early space is still cut short", () => {
  const pcLine = narrator(2, '[Hana]: "I will take the night watch myself, thank you all."');
  expect(howTheySpeak([pcLine], 4, { scene: { ...scene, visibleCast: ["Lieutenant Hana Sorrell"] }, npcs }, "", "Hana")).toEqual({});
  const [line] = howTheySpeak([narrator(2, `[Captain Ilse Vantor]: one two three four five ${"x".repeat(400)}`)], 4, { scene, npcs }, "", "Brian")[
    "Captain Ilse Vantor"
  ]!;
  expect(line!.length).toBeLessThanOrEqual(201);
});

test("someone the last reply names is heard though the scene's cast doesn't list them yet", () => {
  const sorrell = narrator(2, '[Lieutenant Hana Sorrell]: "The water here is warmer than the charts say it should be."');
  expect(Object.keys(howTheySpeak([sorrell], 4, { scene, npcs }, "Sorrell walks back up the sand.", "Brian"))).toEqual(["Lieutenant Hana Sorrell"]);
});
