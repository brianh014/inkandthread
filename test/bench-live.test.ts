import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bench = join(import.meta.dir, "..", "bench", "bench.ts");

/** A live play on the fakes, in a process of its own as an agent's is, and `act` to play one action of it. */
async function livePlay(...flags: string[]) {
  const temp = mkdtempSync(join(tmpdir(), "inkandthread-live-"));
  const folder = join(temp, "play");
  const server = Bun.spawn([process.execPath, bench, "live", "--fake", "--yes", "--label", "test", "--turns", "2", "--folder", folder, ...flags], {
    stdout: "pipe",
    stderr: "pipe",
  });
  while (!existsSync(join(folder, "live.json")) && server.exitCode === null) await Bun.sleep(50);
  // Through `bun bench do`, as an agent plays.
  const run = async (words: string, ...tool: string[]) => {
    const sent = Bun.spawn([process.execPath, bench, "do", folder, ...tool], { stdin: new Blob([words]), stdout: "pipe" });
    return (await new Response(sent.stdout).text()).trim();
  };
  // Straight to the play, which is what that sends, as a process for each is slow.
  const act = async (text: string, tool: string, arg = "", note = "") => {
    const { url } = JSON.parse(readFileSync(join(folder, "live.json"), "utf8"));
    return (await fetch(url, { method: "POST", body: JSON.stringify({ tool, arg, text, note }) })).text();
  };
  const file = (name: string) => readFileSync(join(folder, name), "utf8");
  return { server, run, act, file, remove: () => rmSync(temp, { recursive: true, force: true }) };
}

test("a live play is steered an action at a time, shows nothing hidden, stops at its Turns and is kept", async () => {
  const { server, run, act, file, remove } = await livePlay();
  const seen = [await act("", "look")];
  expect(seen[0]).toMatch(/Story \(M2\)[\s\S]*Choices:[\s\S]*Turns left: 2\./);
  // A Turn with no note is never sent, as the notes are half of what a play is for.
  expect(await act('I say "wait".', "move")).toContain("Add a note");
  seen.push(await run('I say "wait".\n---\nInterested. I expect a knock.', "move"));
  expect(seen.at(-1)).toContain("Turns left: 1.");
  expect(await act("", "choose", "9", "Why not.")).toContain("no such Choice");
  seen.push(await act("Shorter.", "rewrite"));
  seen.push(await act("Who was that?", "ask"));
  seen.push(await act("", "choose", "1", "Bored."));
  expect(await act("", "continue", "", "More.")).toContain("used up");
  // Never to the player's own words, which would be left unanswered.
  expect(await act("", "revert", "M3")).toContain("one of the story's own");
  seen.push(await act("", "revert", "M2"));
  for (const look of ["story", "journal", "inventory", "setup"]) seen.push(await act("", look));
  const { plotThreads, worldBible } = JSON.parse(file("world.json")).opening;
  for (const hidden of [...plotThreads, ...worldBible.map(({ content }: { content: string }) => content)]) expect(seen.join("\n")).not.toContain(hidden);

  expect(await run("It gripped me.\n---\nI'd play on.", "finish")).toContain("Finished");
  await server.exited;
  expect(server.exitCode).toBe(0);
  expect(file("verdict.md")).toContain("I'd play on.");
  expect(file("notes.md")).toContain("Interested. I expect a knock.");
  expect(file("transcript.md")).toContain("Offered: ");
  expect(file("transcript.md")).toContain('Round 1, move "I say "wait"."');
  expect(JSON.parse(file("counts.json")).counts["actions.rewrite"]).toBe(1);
  expect(await run("", "look")).toContain("No play is open");
  remove();
}, 60_000);

test("a live play of a random story keeps the world the app built, so its Turns can be replayed", async () => {
  const { server, act, file, remove } = await livePlay("--random", "--theme", "Mystery");
  await act("Fine.", "finish");
  await server.exited;
  const { save, opening } = JSON.parse(file("world.json"));
  expect(save.theme).toStartWith("Mystery: ");
  expect(save.pc.name).toBeTruthy();
  expect(opening.plotThreads.length).toBeGreaterThan(0);
  expect(opening.worldBible.length).toBeGreaterThan(0);
  remove();
}, 60_000);
