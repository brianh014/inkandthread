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
