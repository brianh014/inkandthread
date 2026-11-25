import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import { applyOperations, knownOnly, openingState } from "../src/state-applier";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let app: ReturnType<typeof startApp>;

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});

afterEach(async () => {
  await app?.stop();
  folder.remove();
});

const play = (...replies: string[]) => {
  app = startApp(savesDir, scriptedTextProvider(...replies).textProvider);
};
const store = () => saveStore(savesDir);
const turn = (id: string) => app.post(`/saves/${id}/turns`, { input: "I wait." });

test("a Save from before What an NPC Knows upgrades with no lists, and a Turn then fills one", async () => {
  play(narration("One."));
  const id = store().create({ worldBrief: "A drowned city", pc: { name: "Ash" }, opening: {} });
  await turn(id);
  await app.stop();
  {
    using db = new Database(join(savesDir, `${id}.sqlite`));
    db.run("DELETE FROM snapshot_sections WHERE name = 'npcKnows'; PRAGMA user_version = 25");
  }
  play(narration("Two.", { op: "add_npc", name: "Nadia", appearance: "a tall woman" }, { op: "npc_learns", name: "Nadia", fact: "Saw the fire" }));

  expect(store().snapshot(id, 1).npcKnows).toEqual({});
  expect((await turn(id)).status).toBe(201);

  expect(store().latestState(id).npcKnows).toEqual({ Nadia: ["Saw the fire"] });
});

test("what someone learns keeps only what they know, never a clause of what they don't", () => {
  expect(knownOnly("Thorne pays Price, but he does not yet know the lad saw the boat.")).toBe("Thorne pays Price.");
  expect(knownOnly("Kit knows nothing of the plot yet; he has only his own sight of the lamp, told to Ash alone.")).toBe(
    "He has only his own sight of the lamp, told to Ash alone.",
  );
  expect(knownOnly("He has never heard of Kit, nor of any lantern.")).toBe("");
  expect(knownOnly("Kit saw the boat and told Ash.")).toBe("Kit saw the boat and told Ash.");
});

test("what someone doesn't know is left out however it's worded, and what they did or kept quiet stays", () => {
  expect(knownOnly("He knows only that a man drowned; he has not heard of the will or the claim.")).toBe("He knows only that a man drowned.");
  expect(knownOnly("He took the verdict; he knows of no hand behind it.")).toBe("He took the verdict.");
  expect(knownOnly("He has the evidence before him but has heard nothing of a ledger.")).toBe("He has the evidence before him.");
  expect(knownOnly("He knows the lad sleeps in the loft, but not what the lad saw.")).toBe("He knows the lad sleeps in the loft.");
  expect(knownOnly("She knows the court holds it, but nothing yet of the letter.")).toBe("She knows the court holds it.");
  expect(knownOnly("He drowned the man, and saw nothing of the woman in the gorse.")).toBe("He drowned the man.");
  expect(knownOnly("She searched the cottage and found nothing, and has told no one.")).toBe(
    "She searched the cottage and found nothing, and has told no one.",
  );
});

test("what a thread gave someone under their title before they were met joins them when met by name alone, and back", () => {
  for (const [given, met] of [
    ["Reverend Amos Thorne", "Amos Thorne"],
    ["Thorne", "Reverend Amos Thorne"],
  ] as const) {
    const state = { ...structuredClone(openingState), npcKnows: { [given]: ["Crane wrote to the Revenue."] } };
    const { next } = applyOperations(state, [{ op: "add_npc", name: met, appearance: "a soft-voiced man in his sixties" }]);
    expect(next.npcKnows).toEqual({ [met]: ["Crane wrote to the Revenue."] });
  }
});

test("what someone learns loses a trailing run of symbols a reply garbled onto it", () => {
  const state = { ...structuredClone(openingState), npcs: [{ name: "Owen", appearance: "a tall man" }] };
  const { next } = applyOperations(state, [{ op: "npc_learns", name: "Owen", fact: "Crane wrote to the Revenue.+#+#+#+#+#+" }]);
  expect(next.npcKnows.Owen).toEqual(["Crane wrote to the Revenue."]);
});

test("a garbled or titled form of someone already met finds them, rather than adding a second person", () => {
  const state = {
    ...structuredClone(openingState),
    npcs: [
      { name: "Reverend Amos Thorne", appearance: "a soft-voiced vicar" },
      { name: "Owen Price", appearance: "a broad constable" },
    ],
  };
  const { next } = applyOperations(state, [
    { op: "add_npc", name: "Rerend Amos Thorne", appearance: "a soft-voiced vicar in a wet coat" },
    { op: "npc_learns", name: "Constable Owen Price", fact: "The ledger is in the chimney." },
  ]);
  expect(next.npcs.map(({ name }) => name)).toEqual(["Reverend Amos Thorne", "Owen Price"]);
  // A relative whose name holds theirs is someone new.
  const father = applyOperations(state, [{ op: "add_npc", name: "Thomas Owen Price", appearance: "an old fisherman" }]).next;
  expect(father.npcs.map(({ name }) => name)).toEqual(["Reverend Amos Thorne", "Owen Price", "Thomas Owen Price"]);
  expect(next.npcKnows).toEqual({ "Owen Price": ["The ledger is in the chimney."] });
});

test("someone of the hidden world the page never names doesn't become known to the PC", async () => {
  const reply = (text: string) =>
    JSON.stringify({
      ...JSON.parse(narration(text, { op: "add_known_npc", name: "Ossery" }, { op: "update_npc", name: "Ossery", appearance: "a stout man in an apron" })),
      people: [{ name: "Ossery", appearance: "a stout man" }],
    });
  play(reply("The well is quiet."), reply("Ossery comes out with a lantern."));
  const id = store().create({
    worldBrief: "A desert",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The well", visibleCast: [] },
      summary: "",
      worldBible: [{ title: "Ossery", keywords: ["Ossery", "innkeeper"], content: "A stout man who keeps the well.", alwaysOn: false }],
    },
  });

  expect((await turn(id)).status).toBe(201);
  expect(store().latestState(id).pcKnown.npcs).toEqual([]);
  // In the state all the same, as the reply's other operations name them.
  expect(
    store()
      .latestState(id)
      .npcs.map(({ name }) => name),
  ).toEqual(["Ossery"]);

  expect((await turn(id)).status).toBe(201);
  expect(store().latestState(id).pcKnown.npcs).toEqual(["Ossery"]);
});

test("a fact said again in one reply is recorded once, and no different one is lost", async () => {
  const promise = "Lise will send the base a truthful acknowledgment tonight saying we are four and the food is good.";
  const again = "Lise will send the base a truthful acknowledgment tonight saying that we are four and the food is good.";
  const other = "The store locker is short four tins of ration beef.";
  play(narration("One.", ...[promise, again, other].map((fact) => ({ op: "add_known_fact", fact }))));
  const id = store().create({ worldBrief: "A station", pc: { name: "Ash" }, opening: {} });

  await turn(id);
  expect(store().latestState(id).pcKnown.facts).toEqual([again, other]);
});
