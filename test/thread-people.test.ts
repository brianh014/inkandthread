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
