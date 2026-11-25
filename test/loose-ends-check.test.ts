import { expect, test } from "bun:test";
import { CHECK_FACTS, CHECK_LOOSE_ENDS, closeLooseEnds, settledOf } from "../src/loose-ends-check";
import type { SaveStore } from "../src/save-store";
import { applyEdit, openingState, type State, type WorldEdit } from "../src/state-applier";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

const ends = (count: number) => Array.from({ length: count }, (_, at) => `Loose end ${at}.`);
const signal = new AbortController().signal;

/** Just what the check reads and writes of a Save. */
const savesWith = (state: State, playersEdits: WorldEdit[] = []) => {
  const changes: WorldEdit[][] = [];
  const saves = {
    latestMessageId: () => 7,
    latestState: () => state,
    messages: () => [{ id: 7, role: "narrator", text: "Ash keeps the promise." }],
    playersEdits: () => playersEdits,
    addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits),
  };
  return { saves: saves as unknown as SaveStore, changes };
};

test("a reply's numbers name each Loose End once, none past the list and none the player just wrote", () => {
  expect(settledOf(ends(12), [1, 1, 3, 0, 13, 5], ["Loose end 4."])).toEqual({ named: 3, settled: ["Loose end 0.", "Loose end 2."] });
});

test("a pause closes at most a quarter of the Loose Ends, the first named first, and none when a reply names over half", () => {
  expect(settledOf(ends(12), [4, 1, 2, 3]).settled).toEqual(["Loose end 3.", "Loose end 0.", "Loose end 1."]);
  expect(settledOf(ends(12), [1, 2, 3, 4, 5, 6, 7])).toEqual({ named: 7, settled: [] });
});

test("the pause closes what the Scribe found settled, asks nothing with few open, and a failure closes none", async () => {
  const state = { ...structuredClone(openingState), looseEnds: ends(CHECK_LOOSE_ENDS) };
  const checked = savesWith(state);
  await closeLooseEnds(scriptedTextProvider(JSON.stringify({ settled: [2] })).textProvider, checked.saves, "save", signal);

  const [[edit]] = checked.changes as [[WorldEdit]];
  expect(edit).toMatchObject({ moved: true, settled: ["Loose end 1."] });
  expect(applyEdit(state, edit).looseEnds).not.toContain("Loose end 1.");

  const few = scriptedTextProvider();
  await closeLooseEnds(few.textProvider, savesWith({ ...state, looseEnds: ends(CHECK_LOOSE_ENDS - 1) }).saves, "save", signal);
  expect(few.prompts).toHaveLength(0);

  const failed = savesWith(state);
  await closeLooseEnds(scriptedTextProvider(new Error("down")).textProvider, failed.saves, "save", signal);
  expect(failed.changes).toHaveLength(0);
});

test("a pause drops at most a tenth of a long list of known facts, in the same call, and only once there are many", async () => {
  const facts = Array.from({ length: CHECK_FACTS }, (_, at) => `Fact ${at}.`);
  const state = { ...structuredClone(openingState), pcKnown: { ...openingState.pcKnown, facts } };
  const checked = savesWith(state);
  const script = scriptedTextProvider(JSON.stringify({ outdated: [2, 4, 6, 8, 10] }));
  await closeLooseEnds(script.textProvider, checked.saves, "save", signal);

  const [[edit]] = checked.changes as [[WorldEdit]];
  expect(edit).toMatchObject({ moved: true, outdated: ["Fact 1.", "Fact 3.", "Fact 5."] });
  expect(applyEdit(state, edit).pcKnown.facts).toHaveLength(CHECK_FACTS - 3);
  // Nothing of the Loose Ends, which are few, and the facts first, for the cache.
  const [system, user] = script.prompts[0]!;
  expect(system!.content).not.toContain("In settled");
  expect(Object.keys(JSON.parse(user!.content))).toEqual(["known_facts", "summary", "latest_replies"]);

  const both = scriptedTextProvider(JSON.stringify({ settled: [1], outdated: [] }));
  await closeLooseEnds(both.textProvider, savesWith({ ...state, looseEnds: ends(CHECK_LOOSE_ENDS) }).saves, "save", signal);
  expect(both.prompts).toHaveLength(1);
  expect(both.prompts[0]![0]!.content).toContain("In settled");

  // Never the player's own, nor both of two that say the same.
  const said = "The brass key opens the old crypt door.";
  const again = "The old crypt door opens with the brass key.";
  const pair = { ...state, pcKnown: { ...state.pcKnown, facts: [said, again, ...facts] } };
  const own = savesWith(pair, [{ edit: "fact", old: null, new: "Fact 1." }]);
  await closeLooseEnds(scriptedTextProvider(JSON.stringify({ outdated: [1, 2, 4] })).textProvider, own.saves, "save", signal);
  expect((own.changes as [[WorldEdit]])[0][0]).toMatchObject({ outdated: [said] });

  const few = scriptedTextProvider();
  await closeLooseEnds(few.textProvider, savesWith({ ...state, pcKnown: { ...state.pcKnown, facts: facts.slice(1) } }).saves, "save", signal);
  expect(few.prompts).toHaveLength(0);
});

test("a Save gives every edit the player made, on its Messages and since, and none a World Change wrote", async () => {
  const folder = tempFolder();
  // The edit's own settling fails, which the Turn plays on past.
  const script = scriptedTextProvider(new Error("down"), narration("It begins."));
  const app = startApp(join(folder.path, "Saves"), script.textProvider);
  const id = await app.createSave();
  const saves = saveStore(join(folder.path, "Saves"));
  const wrote = (text: string) => saves.addEdit(id, { edit: "fact", old: null, new: text });
  wrote("Before a Turn.");
  expect((await app.post(`/saves/${id}/turns`, { input: "I look." })).status).toBe(201);
  wrote("Since the last.");
  const update = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };
  saves.addWorldChange(id, saves.latestMessageId(id), [{ edit: "world", update, made: 0, outdated: ["Nothing."] }]);

  expect(saves.playersEdits(id)).toEqual([
    { edit: "fact", old: null, new: "Before a Turn." },
    { edit: "fact", old: null, new: "Since the last." },
  ]);
  await app.stop();
  folder.remove();
});
