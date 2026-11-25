import { expect, test } from "bun:test";
import { threadPeople } from "../src/thread-people";

const people = threadPeople({
  npcs: [
    { name: "Kit", appearance: "a boy" },
    { name: "Thorne", appearance: "a vicar" },
    { name: "Mara", appearance: "a smith" },
  ],
  worldBible: [{ title: "The Gilded Rose", keywords: ["Gilded Rose", "inn"], content: "An inn.", alwaysOn: false }],
});

test("a plan's doer is the last person it names before its verb, never a place or someone it touches", () => {
  expect(people.doer("At six Thorne will take Kit from the dock.")).toContain("Thorne");
  expect(people.doer("After Kit leaves, Thorne will burn the page.")).toContain("Thorne");
  expect(people.doer("At the Gilded Rose, Kit will slip the ledger to Mara.")).toContain("Kit");
  expect(people.doer("At dawn the smugglers will drag Kit to the cove.")).toBeUndefined();
  // With no such verb, the first it names.
  expect(people.doer("Mara, at the forge by noon.")).toContain("Mara");
  expect(people.doerIn("At six Thorne will take Kit from the dock.", ["Kit"])).toBe(false);
  expect(people.doerIn("Kit will slip away.", ["Kit"])).toBe(true);
});

test("a doer is with the PC by any name they go by, as a character's Lore Entry holds their full name", () => {
  const station = threadPeople({
    npcs: [{ name: "Okafor", appearance: "a man" }],
    worldBible: [{ title: "Brandt Okafor", keywords: ["Brandt Okafor", "Okafor"], content: "The station chief.", alwaysOn: false }],
  });
  expect(station.doerIn("At six Okafor will burn the page.", ["Okafor"])).toBe(true);
  expect(station.doerIn("At six Brandt Okafor will burn the page.", ["Okafor"])).toBe(true);
});

test("a doer is never with the PC by a surname shared with someone who is", () => {
  const family = threadPeople({
    npcs: [
      { name: "Jon Vell", appearance: "a man" },
      { name: "Mara Vell", appearance: "a woman" },
    ],
    worldBible: [],
  });
  expect(family.doerIn("At six Jon Vell will burn the letter.", ["Mara Vell"])).toBe(false);
  expect(family.doerIn("At six Jon Vell will burn the letter.", ["Jon Vell"])).toBe(true);
});

test("a plan that names its doer only as he or she is given the name the now written with it opens with", () => {
  const { withDoer, doer } = threadPeople({
    npcs: [
      { name: "Thorne", appearance: "a man of fifty, a vicar" },
      { name: "Mara Vell", appearance: "a woman of thirty" },
    ],
    // Someone never met, known only by their Lore Entry.
    worldBible: [{ title: "Arne Vik", keywords: ["Arne Vik", "Vik"], content: "A geologist.", alwaysOn: false }],
  });
  const now = "Vik came back before first light, and Thorne saw him.";
  const named = withDoer("At 03:06 he leaves the hut with the knife.", now);
  expect(named).toBe("At 03:06 Vik leaves the hut with the knife.");
  expect(doer(named)).toContain("Vik");
  expect(withDoer("Before first light he goes to the hut.", now)).toBe("Before first light Vik goes to the hut.");
  expect(withDoer("He burns the page.", "Thorne is at home.")).toBe("Thorne burns the page.");
  expect(withDoer("At half past five she takes her lamp.", "Mara Vell has the key.")).toBe("At half past five Mara Vell takes her lamp.");
  // Left alone: a named doer, one whose looks say otherwise, someone's thing, no one known, and the PC.
  for (const [plan, opening] of [
    ["At seven Sefa sends two riders while she waits.", now],
    ["At six she burns the page.", "Thorne is at home."],
    ["At six he burns the page.", "Thorne's lamp is lit."],
    ["At six he burns the page.", "Thorneybrook burns."],
    ["At six he burns the page.", "The lamp is lit and Thorne sleeps."],
    ["At dusk the widow tells what she knows.", "Mara Vell has the key."],
  ] as const)
    expect(withDoer(plan, opening)).toBe(plan);
  expect(withDoer("At six he burns the page.", "Thorne is at home.", ["Thorne"])).toBe("At six he burns the page.");
});
