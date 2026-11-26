import { expect, test } from "bun:test";
import { markByLooks } from "../src/image-pipeline";

// A picture's prompt that pictures someone in view with no mark sends no portrait, so their face is invented (ticket 106).
const INGRID = { name: "Ingrid", looks: "A tall woman of forty with cropped grey hair and a navy parka." };
const OKAFOR = { name: "Brandt Okafor", looks: "A heavy-set man of fifty with a grey-shot beard." };

test("someone in view whom the prompt pictures with no mark is marked, where only they fit", () => {
  const prompt = "A narrow galley lit by one lamp. A woman inside leans over the stove while a heavy-set man watches from the door.";

  expect(markByLooks(prompt, [INGRID, OKAFOR])).toBe(
    "A narrow galley lit by one lamp. [Ingrid: A woman] inside leans over the stove while [Brandt Okafor: a heavy-set man] watches from the door.",
  );
});

test("a figure is marked only when one person is left, and never where two could be meant", () => {
  expect(markByLooks("A second figure in a heavy sweater crouches by the drums.", [INGRID])).toBe(
    "[Ingrid: A second figure] in a heavy sweater crouches by the drums.",
  );
  expect(markByLooks("A figure crouches by the drums.", [INGRID, OKAFOR])).toBe("A figure crouches by the drums.");
});

test("a mark already there is left alone, and no one is marked twice or against their looks", () => {
  const prompt = "[Ingrid: A tall woman] stands by the door. A man and another man argue at the table.";

  expect(markByLooks(prompt, [OKAFOR])).toBe("[Ingrid: A tall woman] stands by the door. [Brandt Okafor: A man] and another man argue at the table.");
  expect(markByLooks("A woman stands by the door.", [OKAFOR])).toBe("A woman stands by the door.");
});
