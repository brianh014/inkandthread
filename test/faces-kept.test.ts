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

test("a figure is marked only when one person is left and the prompt pictures no one else", () => {
  expect(markByLooks("A second figure in a heavy sweater crouches by the drums.", [INGRID])).toBe(
    "[Ingrid: A second figure] in a heavy sweater crouches by the drums.",
  );
  expect(markByLooks("A figure crouches by the drums.", [INGRID, OKAFOR])).toBe("A figure crouches by the drums.");
  expect(markByLooks("A figure on the far pier, and a man by the rail.", [INGRID])).toBe("A figure on the far pier, and a man by the rail.");
});

test("no one is marked where the noun could be someone already there, another of their kind, or no one in the frame", () => {
  // Two men, one marked: the other may be a stranger.
  expect(markByLooks("[Brandt Okafor: A heavy-set man] stands by the stove. A man in a helmet waits.", [{ name: "Ash", looks: "A lean man." }])).toBe(
    "[Brandt Okafor: A heavy-set man] stands by the stove. A man in a helmet waits.",
  );
  // "The man" points back at someone, and a possessive or compound pictures no one.
  expect(markByLooks("The man turns to the door.", [OKAFOR])).toBe("The man turns to the door.");
  expect(markByLooks("A woman's voice calls over a man-sized crate.", [INGRID, OKAFOR])).toBe("A woman's voice calls over a man-sized crate.");
  // A girl is never an adult woman, nor a woman someone whose looks say nothing.
  expect(markByLooks("A girl in a red hood runs past.", [INGRID])).toBe("A girl in a red hood runs past.");
  expect(markByLooks("A woman stands by the door.", [{ name: "Ash", looks: "Tall, grey hair." }])).toBe("A woman stands by the door.");
  // Nor anyone inside a likeness sentence left open.
  expect(markByLooks("Snow on the glass. {Keep a woman from image 1 as she is", [INGRID])).toBe("Snow on the glass. {Keep a woman from image 1 as she is");
});

test("the kind comes from the looks first, and the background only when the looks say none", () => {
  const tom = { name: "Tom", looks: "Tall and scarred.", about: "He was raised by his aunt; her inn burned down." };
  expect(markByLooks("A man waits at the door.", [tom])).toBe("[Tom: A man] waits at the door.");
  expect(markByLooks("A woman waits at the door.", [tom])).toBe("A woman waits at the door.");
  expect(markByLooks("A woman waits.", [{ name: "", looks: "A woman." }])).toBe("A woman waits.");
});
