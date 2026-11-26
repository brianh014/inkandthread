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
