import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, join } from "node:path";
import { commandInput } from "../src/command-provider";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { textProvider } from "../src/text-provider";
import { commandText, commandWords } from "../src/web/api";
import { logOf, scriptedDice, scriptedImages, startApp, tempFolder } from "./support";

type Rule = { when?: string; reply?: string; exit?: number; hang?: boolean };

let folder: ReturnType<typeof tempFolder>;
let app: ReturnType<typeof startApp> | undefined;
let rules: string;

const FAKE = join(import.meta.dir, "fake-command.ts");
const TURN = '{"check":null,"narration":"The tide rises.","state_operations":[]}';
const SHEET = JSON.stringify({ wearing: [], health: "unhurt", injuries: [], conditions: [] });
const WORLD = JSON.stringify({
  world_overview: "Rain never stops in Saltmere.",
  calendar: "Days run in weeks of seven.",
  start_date: "3rd of Lowtide",
  start_time_of_day: "dusk",
  lore_entries: [{ title: "The Tide Court", keywords: ["Tide Court", "the court", "magistrates"], content: "Its judges drown the guilty." }],
  world_rules: ["Magic does not exist."],
  plot_threads: ["The mayor is a drowned ghost."],
});
const WORLD_CHANGE = JSON.stringify({
  lore_entries: [],
  removed_lore: [],
  world_rules: [{ old: "Magic does not exist.", new: "Smuggling pays." }],
  plot_threads: [],
  world_brief: null,
  summary: null,
  facts: [],
  npc_summaries: [],
});
// By what only each call's schema holds, first match first.
const PLAYS: Rule[] = [
  { when: "world_overview", reply: WORLD },
  { when: "npc_summaries", reply: WORLD_CHANGE },
  { when: "state_operations", reply: TURN },
  { when: "injuries", reply: SHEET },
];

/** Settings with the fake command, written straight to the file, as a player sets it. */
function useCommand(given: Rule[], minutes = 8) {
  writeFileSync(rules, JSON.stringify(given));
  writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ textCommand: [process.execPath, FAKE, rules], textReplyMinutes: minutes }));
  return settingsStore(join(folder.path, "settings.json"));
}

const inputs = () => (existsSync(`${rules}.inputs`) ? readFileSync(`${rules}.inputs`, "utf8").split("\n=====\n").slice(0, -1) : []);
const ask = (settings: ReturnType<typeof settingsStore>, signal = new AbortController().signal) =>
  textProvider(settings)([{ role: "user", content: "Say hello." }], { onText: () => {}, signal });

/** Whether the process the hanging fake wrote down still runs. */
const running = () => {
  try {
    process.kill(Number(readFileSync(`${rules}.pid`, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  folder = tempFolder();
  rules = join(folder.path, "rules.json");
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  folder.remove();
});

test("the prompt goes in as text under its roles, with the schema last only when it's missing", () => {
  const prompt = [
    { role: "system" as const, content: "Be the Narrator." },
    { role: "user" as const, content: "I wade in." },
  ];
  expect(commandInput(prompt)).toBe("[system]\nBe the Narrator.\n\n[user]\nI wade in.");
  expect(commandInput(prompt, { type: "object" })).toEndWith('Reply only with JSON matching this schema: {"type":"object"}');
  const given = [{ role: "user" as const, content: 'Reply as {"type":"object"}' }];
  expect(commandInput(given, { type: "object" })).toBe('[user]\nReply as {"type":"object"}');
});

test("a world build, a Turn and a World Change all run through the command", async () => {
  const settings = useCommand(PLAYS);
  app = startApp(join(folder.path, "Saves"), textProvider(settings));

  const built = await app.post("/worlds", { title: "Salt", theme: "Western", worldBrief: "A drowned city", startingHook: "", pc: { name: "Ash" } });
  expect(built.status).toBe(201);
  const { id: world } = (await built.json()) as { id: string };
  const begun = await app.post(`/worlds/${world}/begin`, { artStyle: "" });
  const { id } = (await begun.json()) as { id: string };
  expect(saveStore(join(folder.path, "Saves")).latestState(id).worldRules).toEqual(["Magic does not exist."]);

  expect((await app.post(`/saves/${id}/turns`, { input: "I wade forward." })).status).toBe(201);
  expect(saveStore(join(folder.path, "Saves")).messages(id).at(-1)!.text).toBe("The tide rises.");

  expect((await app.post(`/saves/${id}/world-change`, { change: "the mayor smuggles" })).status).toBe(200);
  expect(saveStore(join(folder.path, "Saves")).latestState(id).worldRules).toEqual(["Smuggling pays."]);

  expect(inputs()[0]).toStartWith("[system]\n");
});

test("each call logs the program, exit code, time and reply length, and none of the story", async () => {
  const settings = useCommand([{ reply: "ZQX-STORY hello" }]);
  const log = await logOf(() => ask(settings));
  const line = log.split("\n").find((each) => each.includes("Command reply"))!;
  expect(line).toContain("bun");
  expect(line).toMatch(/"exit":0/);
  expect(line).toMatch(/"ms":\d+/);
  expect(line).toMatch(/"chars":15/);
  expect(log).not.toContain("ZQX-STORY");
  expect(log).not.toContain(rules);
});

test("a command that fails or prints nothing fails as a Text Provider does, saying why", async () => {
  await expect(ask(useCommand([{ reply: "partial", exit: 3 }]))).rejects.toThrow(/exit code 3/);
  await expect(ask(useCommand([{ reply: " " }]))).rejects.toThrow(/printed nothing/);
  writeFileSync(join(folder.path, "settings.json"), JSON.stringify({ textCommand: ["no-such-program-zqx"] }));
  await expect(ask(settingsStore(join(folder.path, "settings.json")))).rejects.toThrow(/can't be run/);
});

test("a Turn's reply with no JSON is retried, then fails as other replies do", async () => {
  const settings = useCommand([{ reply: "I'd rather not write JSON." }]);
  app = startApp(join(folder.path, "Saves"), textProvider(settings));
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(502);
  expect(inputs().length).toBe(3);
});

test("a command past the reply time limit is killed and fails", async () => {
  const settings = useCommand([{ hang: true }], 0.01);
  await expect(ask(settings)).rejects.toThrow(/time limit/);
  await Bun.sleep(300);
  expect(running()).toBe(false);
});

test("a command is killed when the player stops it", async () => {
  const settings = useCommand([{ hang: true }]);
  const stop = new AbortController();
  const asked = ask(settings, stop.signal);
  while (!existsSync(`${rules}.pid`)) await Bun.sleep(20);
  stop.abort();
  await expect(asked).rejects.toBeDefined();
  await Bun.sleep(300);
  expect(running()).toBe(false);
});

/** A server open to the network, as the Server download runs, with its Settings routes reached by address. */
function openServer() {
  const server = startServer({
    savesDir: join(folder.path, "Saves"),
    settings: settingsStore(join(folder.path, "settings.json")),
    textProvider: async () => "",
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    hostname: "0.0.0.0",
  });
  const at = (host: string) => new URL(`http://${host}:${server.port}/settings`);
  return {
    stop: () => server.stop(true),
    get: (host: string) => fetch(at(host)).then((r) => r.json()),
    patch: (host: string, body: object, headers: Record<string, string> = {}) =>
      fetch(at(host), { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

const stored = () => JSON.parse(readFileSync(join(folder.path, "settings.json"), "utf8")).textCommand;
// This machine's own address on its network, as another device reaches it. CI runners have one.
const LAN = Object.values(networkInterfaces())
  .flat()
  .find((each) => each?.family === "IPv4" && !each.internal)?.address;

test("Settings on this computer can change the command, but not a page rebinding its domain to it", async () => {
  useCommand(PLAYS);
  const server = openServer();
  try {
    // Sent from this computer, but under the page's own name.
    expect((await server.patch("127.0.0.1", { textCommand: ["calc.exe"] }, { Host: "rebound.example" })).status).toBe(403);
    expect(stored()).toEqual([process.execPath, FAKE, rules]);

    expect(await server.get("127.0.0.1")).toMatchObject({ textCommand: [process.execPath, FAKE, rules], commandHere: true });
    expect((await server.patch("localhost", { textCommand: ["claude", "-p"] })).status).toBe(200);
    expect(stored()).toEqual(["claude", "-p"]);
  } finally {
    await server.stop();
  }
});

test.skipIf(!LAN)("another device sees only the command's program, and can't change it", async () => {
  useCommand(PLAYS);
  const server = openServer();
  try {
    const seen = await server.get(LAN!);
    // Its arguments may hold a key.
    expect(seen).toMatchObject({ textCommand: [basename(process.execPath)], commandHere: false });
    expect((await server.patch(LAN!, { textCommand: ["calc.exe"] })).status).toBe(403);
    // The form sends every field, so the command as it was shown, with anything else, saves and keeps the command whole.
    expect((await server.patch(LAN!, { textCommand: seen.textCommand, fontSize: "large" })).status).toBe(200);
    expect(stored()).toEqual([process.execPath, FAKE, rules]);
  } finally {
    await server.stop();
  }
});

test("a command line splits at spaces, keeping quoted ones, and reads back as typed", () => {
  expect(commandWords(' claude  -p "/opt/my tools/cli" --flag')).toEqual(["claude", "-p", "/opt/my tools/cli", "--flag"]);
  expect(commandText(["claude", "-p", "/opt/my tools/cli"])).toBe('claude -p "/opt/my tools/cli"');
});
