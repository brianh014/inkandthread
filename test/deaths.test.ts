import { expect, test } from "bun:test";
import { restyledBy } from "../src/image-pipeline";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import { applyOperations, isBody, openingState, type State } from "../src/state-applier";
import { threadPeople } from "../src/thread-people";
import { deathsShown } from "../src/turn-engine";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

// Someone killed in play is marked dead, so no one paints, plans for or asks a part of them (ticket 109).
const withState = (sections: Partial<State> = {}): State => ({
  ...structuredClone(openingState),
  npcs: [
    { name: "Arne Vik", appearance: "A big fair-bearded man." },
    { name: "Lise Moen", appearance: "A small woman with a braid." },
  ],
  ...sections,
});

test("a death the narration shows is kept under the state's own name, and a stranger's is passed over, never refused", () => {
  const { next, refused, ignored } = applyOperations(withState(), [
    { op: "npc_dies", name: "Vik" },
    { op: "npc_dies", name: "A guard" },
  ]);

  expect(next.dead).toEqual(["Arne Vik"]);
  expect(isBody(next, "Arne Vik")).toBe(true);
  expect(isBody(next, "Lise Moen")).toBe(false);
  expect(refused).toEqual([]);
  expect(ignored).toHaveLength(1);
});

test("the dead keep their death through a merge, and their portrait is never redrawn for a death wound", () => {
  const dead = applyOperations(withState(), [{ op: "npc_dies", name: "Arne Vik" }]).next;
  const merged = applyOperations(dead, [{ op: "merge_npc", name: "Arne Vik", into: "Arne" }]).next;
  expect(merged.dead).toEqual(["Arne"]);

  const wounded = applyOperations(dead, [{ op: "update_npc", name: "Arne Vik", appearance: "A big fair-bearded man, his throat cut.", portrait: true }]).next;
  expect(restyledBy(dead, wounded)).toEqual([]);
});

test("a plan is the dead's only when its doer is them by full name, never someone who shares a name", () => {
  const state = withState({
    npcs: [
      { name: "Arne Vik", appearance: "A gaunt man." },
      { name: "Jon Vik", appearance: "A young man." },
    ],
  });
  const { doerIsOne } = threadPeople(state);

  expect(doerIsOne("At dusk Jon Vik will open the gate.", ["Arne Vik"])).toBe(false);
  expect(doerIsOne("At dusk Arne Vik will open the gate.", ["Arne Vik"])).toBe(true);
});

test("someone marked dead who speaks on the page lives after all", async () => {
  const folder = tempFolder();
  const script = scriptedTextProvider(
    narration("Arne falls still, dead.", { op: "add_npc", name: "Arne Vik", appearance: "A big man." }, { op: "npc_dies", name: "Arne Vik" }),
    narration('[Arne Vik]: "Not yet."'),
  );
  const app = startApp(join(folder.path, "Saves"), script.textProvider);
  try {
    const id = await app.createSave();
    await app.post(`/saves/${id}/turns`, { input: "I strike." });
    expect(saveStore(join(folder.path, "Saves")).latestState(id).dead).toEqual(["Arne Vik"]);
    await app.post(`/saves/${id}/turns`, { input: "I look down." });
    expect(saveStore(join(folder.path, "Saves")).latestState(id).dead).toEqual([]);
  } finally {
    await app.stop();
    folder.remove();
  }
});

test("a death is kept only where the page tells it beside their name, never for someone merely in the scene", () => {
  const npcs = [{ name: "Arne Vik" }, { name: "Lise Moen" }];
  const dies = (name: string) => ({ op: "npc_dies" as const, name });

  const told = deathsShown(
    [dies("Arne Vik"), dies("Lise Moen")],
    "Arne Vik falls against the stove. He is dead before he hits the floor.\n\nLise Moen screams.",
    npcs,
  );

  expect(told.kept).toEqual([dies("Arne Vik")]);
  expect(told.dropped).toBe(1);
});

test("a death only reported or believed is no death", () => {
  const told = deathsShown([{ op: "npc_dies", name: "Arne Vik" }], "Arne Vik, reported dead a month ago, steps out of the dark.", [{ name: "Arne Vik" }]);

  expect(told.kept).toEqual([]);
});

test("a sound dying away, or dead meaning very, is no death", () => {
  const dies = { op: "npc_dies" as const, name: "Harriet Vell" };
  const npcs = [{ name: "Harriet Vell" }];
  // As Harriet was marked dead for "Mrs Vell let the silence sit while a burst of laughter went up and died away again."
  for (const said of [
    "Mrs Vell let the silence sit while the laughter died away again.",
    "Harriet Vell spoke, and the noise died down.",
    "Harriet Vell came in the dead of night.",
  ])
    expect(deathsShown([dies], said, npcs).kept).toEqual([]);
  // A death told in the same words still counts, and so does a body that is still or a weight.
  for (const said of ["Harriet Vell died out there on the moor.", "They carried Harriet Vell, a dead weight.", "Harriet Vell lay dead still."])
    expect(deathsShown([dies], said, npcs).kept).toEqual([dies]);
  expect(deathsShown([dies], "Harriet Vell died in the night.", npcs).kept).toEqual([dies]);
  expect(deathsShown([dies], "Harriet Vell fell dead on the flags.", npcs).kept).toEqual([dies]);
});

test("someone's own line about a death is no death of theirs, though a death called out aloud is", () => {
  const npcs = [{ name: "Pavel Duda" }, { name: "Lise Moen" }];
  const dies = (name: string) => ({ op: "npc_dies" as const, name });

  expect(deathsShown([dies("Pavel Duda")], '[Pavel Duda]: "I\'ll be in the kennel. Lise is alone with two dead dogs."', npcs).kept).toEqual([]);
  expect(deathsShown([dies("Pavel Duda")], '[Lise Moen]: "Pavel Duda is dead. He stopped breathing."', npcs).kept).toEqual([dies("Pavel Duda")]);
});

test("a death word for something else in their sentence, or their killing someone, is no death of theirs", () => {
  const npcs = [{ name: "Tamsin" }, { name: "Vane" }, { name: "Corl" }, { name: "Lise Moen" }, { name: "A guard" }];
  const dies = (name: string) => ({ op: "npc_dies" as const, name });
  const kept = (name: string, said: string) => deathsShown([dies(name)], said, npcs).kept.length === 1;
  // The bench's own sentence, as the camel was dead, not Tamsin.
  expect(kept("Tamsin", "Tamsin had come down the line and stood at the dead beast's shoulder with her rope hanging from her hand.")).toBe(false);
  expect(kept("Lise Moen", "Lise Moen knelt by the dead man.")).toBe(false);
  expect(kept("Tamsin", "Tamsin killed the camel with one shot.")).toBe(false);
  expect(kept("Vane", "Vane shot Corl dead.")).toBe(false);
  expect(kept("Corl", "Vane shot Corl dead.")).toBe(true);
  // Their own deaths, still kept.
  for (const said of [
    "Tamsin was killed by the fall.",
    "Tamsin, killed outright, slid from the saddle.",
    "Tamsin killed herself before dawn.",
    "The blow left her dead on the sand beside Tamsin's camel.",
  ])
    expect(kept("Tamsin", said)).toBe(true);
  expect(kept("Corl", "Corl hit the sand. The dead man's hand lay open.")).toBe(true);
  expect(kept("A guard", "A guard fell. The dead guard did not move.")).toBe(true);
});
