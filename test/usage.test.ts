import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { settingsStore } from "../src/settings-store";
import { StoppedOnPurpose } from "../src/turn-engine";
import { countedImages, countedText, usageStore } from "../src/usage-store";
import { CONTINUE } from "../src/prompt-assembler";
import { niceCeiling, QUIET_TURNS, quietNotes, recentPeriods, stacks } from "../src/web/usage";
import { logOf, narration, png, scriptedDice, scriptedTextProvider, startApp, tempFolder } from "./support";

const text = { kind: "text" as const, provider: "openrouter.ai", model: "m", failed: false };

describe("Usage", () => {
  test("sums by day, by week from Monday and by month, and keeps a cost no one reported as none", () => {
    const usage = usageStore();
    // Sunday 29 Nov ends one week, and Tuesday 1 Dec is in the next and a new month.
    usage.record({ ...text, tokensIn: 100, tokensOut: 10, cached: 50, cost: 0.01 }, "2026-11-29");
    usage.record({ ...text, failed: true }, "2026-11-29");
    usage.record({ ...text, tokensIn: 200, cost: 0.02 }, "2026-12-01");
    usage.record({ kind: "image", provider: "wiro", model: "x", failed: false }, "2026-12-01");

    expect(usage.summary("day").text).toEqual([
      { period: "2026-12-01", provider: "openrouter.ai", model: "m", requests: 1, failed: 0, tokensIn: 200, tokensOut: 0, cached: 0, cost: 0.02, priced: 1 },
      { period: "2026-11-29", provider: "openrouter.ai", model: "m", requests: 2, failed: 1, tokensIn: 100, tokensOut: 10, cached: 50, cost: 0.01, priced: 1 },
    ]);
    expect(usage.summary("week").text.map(({ period, requests }) => [period, requests])).toEqual([
      ["2026-11-30", 1],
      ["2026-11-23", 2],
    ]);
    expect(usage.summary("month").text.map(({ period, requests }) => [period, requests])).toEqual([
      ["2026-12", 1],
      ["2026-11", 2],
    ]);
    expect(usage.summary("month").images).toEqual([{ period: "2026-12", provider: "wiro", model: "x", requests: 1, failed: 0, cost: null, priced: 0 }]);
  });

  test("counts a text call that throws as failed, but not one the player stopped or one stopped on purpose", async () => {
    const folder = tempFolder().path;
    const settings = settingsStore(join(folder, "settings.json"));
    settings.update({ textBaseUrl: "https://openrouter.ai/api/v1", textModel: "m" });
    const usage = usageStore();
    const counted = countedText(
      async (_prompt, { onUsage, signal }) => {
        onUsage?.({ prompt_tokens: 7, cost: 0.5 });
        if (signal.aborted) throw new Error("stopped");
        throw new Error("down");
      },
      usage,
      settings,
    );
    await counted([], { onText: () => {}, signal: new AbortController().signal }).catch(() => {});
    const stopped = new AbortController();
    stopped.abort();
    await counted([], { onText: () => {}, signal: stopped.signal }).catch(() => {});
    const runaway = new AbortController();
    runaway.abort("ran on far too long");
    await counted([], { onText: () => {}, signal: runaway.signal }).catch(() => {});
    // Stopped on purpose once a Check is rated, so counted but not failed.
    const rated = new AbortController();
    rated.abort(new StoppedOnPurpose("rated for a Check"));
    await counted([], { onText: () => {}, signal: rated.signal }).catch(() => {});

    const [row] = usage.summary("day").text;
    expect(row).toMatchObject({ provider: "openrouter.ai", model: "m", requests: 4, failed: 2, tokensIn: 28, cost: 2, priced: 4 });
  });

  test("usage heard after a text call ended adds its cost to that request, not another request", async () => {
    const settings = settingsStore(join(tempFolder().path, "settings.json"));
    settings.update({ textBaseUrl: "https://openrouter.ai/api/v1", textModel: "m" });
    const usage = usageStore();
    let late: ((found: { prompt_tokens: number; cost: number }) => void) | undefined;
    const counted = countedText(
      async (_prompt, { onUsage }) => {
        late = onUsage;
        throw new Error("cut off");
      },
      usage,
      settings,
    );
    await counted([], { onText: () => {}, signal: new AbortController().signal }).catch(() => {});
    late!({ prompt_tokens: 40, cost: 0.2 });

    expect(usage.summary("day").text).toMatchObject([{ requests: 1, failed: 1, tokensIn: 40, cost: 0.2, priced: 1 }]);
  });

  test("counts pictures with the cost an adapter reports", async () => {
    const folder = tempFolder().path;
    const settings = settingsStore(join(folder, "settings.json"));
    settings.update({ imageModel: "flux" });
    const usage = usageStore();
    const { nanogpt } = countedImages(
      {
        nanogpt: async (_payload, _signal, onCost) => {
          onCost?.(0.03);
          return png(1);
        },
      },
      usage,
      settings,
    );
    await nanogpt!({ prompt: "", aspect_ratio: "1:1", reference_images: [], style_preset: "", seed: 1 }, new AbortController().signal);
    expect(usage.summary("day").images).toMatchObject([{ provider: "nanogpt", model: "flux", requests: 1, failed: 0, cost: 0.03, priced: 1 }]);
  });

  test("the route checks its period", async () => {
    const app = startApp(join(tempFolder().path, "Saves"), async () => "fine");
    expect((await app.get("/settings/usage?by=year")).status).toBe(400);
    expect(await (await app.get("/settings/usage?by=day")).json()).toEqual({ text: [], images: [] });
  });
});

describe("Narrator usage", () => {
  test("tallies each Turn's Check and state changes by story and model, and counts Turns since a Check and since time moved", () => {
    const usage = usageStore();
    usage.turn("a", "m", { difficulty: "Hard", operations: ["set_story_time", "add_known_fact", "add_plot_thread", "add_plot_thread"] });
    usage.turn("a", "m", { operations: [] });
    usage.turn("a", "m", { operations: ["update_plot_thread", "add_loose_end", "set_scene"] });
    usage.turn("a", "other", { difficulty: "Easy", operations: ["resolve_loose_end"] });

    // The story played last with "other", so its row comes first and is the one whose counts since apply.
    const [latest, earlier] = usage.narrator();
    expect(earlier).toEqual({
      save: "a",
      model: "m",
      turns: 3,
      checks: 1,
      easy: 0,
      moderate: 0,
      hard: 1,
      veryHard: 0,
      unchanged: 1,
      timeMoved: 1,
      scenes: 1,
      facts: 1,
      looseOpened: 1,
      looseClosed: 0,
      threadsMoved: 1,
      sinceCheck: 2,
      sinceTime: 2,
      latest: false,
    });
    expect(latest).toMatchObject({ model: "other", turns: 1, checks: 1, easy: 1, looseClosed: 1, sinceCheck: 0, sinceTime: 1, latest: true });
  });

  test("keeps a story's rows together, most played story first, and a Revert restarts its counts since", () => {
    const usage = usageStore();
    usage.turn("x", "a", { operations: [] });
    usage.turn("y", "a", { operations: [] });
    usage.turn("y", "a", { operations: [] });
    usage.turn("x", "b", { operations: [] });
    usage.turn("x", "b", { operations: [] });
    expect(usage.narrator().map(({ save, model }) => `${save}/${model}`)).toEqual(["x/b", "x/a", "y/a"]);

    usage.reverted("x");
    expect(usage.narrator().map(({ save, sinceCheck, sinceTime, turns }) => [save, sinceCheck, sinceTime, turns])).toEqual([
      ["x", 0, 0, 2],
      ["x", 0, 0, 1],
      ["y", 2, 2, 2],
    ]);
  });

  test("counts only the player's own Turns, names each story, logs a Check without its action, and drops a deleted story", async () => {
    const folder = tempFolder().path;
    const script = scriptedTextProvider(
      JSON.stringify({ check: { action: "Leap the flooded gap", difficulty: "Very Hard" } }),
      narration("You fall short."),
      narration("Again, you fall short."),
      narration("The tide comes in."),
    );
    const app = startApp(join(folder, "Saves"), script.textProvider, scriptedDice(4));
    const id = await app.createSave();

    const log = await logOf(() => app.post(`/saves/${id}/turns`, { input: "I leap the gap." }));
    await app.post(`/saves/${id}/messages/2/regenerate`, {});
    await app.post(`/saves/${id}/turns`, { input: CONTINUE });

    expect(log).toContain('"check":{"difficulty":"Very Hard","roll":4,"outcome":"failure","degree":"plain"}');
    expect(log).not.toContain("Leap the flooded gap");
    const { stories } = (await (await app.get("/settings/usage/narrator")).json()) as { stories: Record<string, unknown>[] };
    expect(stories).toEqual([expect.objectContaining({ save: id, title: "Ash", turns: 1, checks: 1, veryHard: 1, unchanged: 1, sinceTime: 1 })]);

    // Regenerate gave the reply a new id, so this goes back to the player's own words.
    expect((await app.post(`/saves/${id}/messages/1/revert`, {})).status).toBe(200);
    expect(await (await app.get("/settings/usage/narrator")).json()).toEqual({ stories: [expect.objectContaining({ turns: 1, sinceTime: 0 })] });

    await app.delete(`/saves/${id}`);
    expect(await (await app.get("/settings/usage/narrator")).json()).toEqual({ stories: [] });
  });

  test("points out a story that went quiet", () => {
    const quiet = { title: "Ash", model: "m", sinceCheck: QUIET_TURNS, sinceTime: QUIET_TURNS - 1, latest: true };
    expect(quietNotes(quiet)).toEqual([`Ash, m: no Check in the last ${QUIET_TURNS} Turns.`]);
    expect(quietNotes({ ...quiet, sinceCheck: 0 })).toEqual([]);
    // A model the story has moved on from.
    expect(quietNotes({ ...quiet, latest: false })).toEqual([]);
  });
});

describe("Usage chart", () => {
  test("ends on the current period: days, weeks from Monday and months", () => {
    // Wednesday 2 December 2026.
    const today = new Date(2026, 11, 2);
    expect(recentPeriods("day", today).slice(-2)).toEqual(["2026-12-01", "2026-12-02"]);
    expect(recentPeriods("day", today)).toHaveLength(14);
    expect(recentPeriods("week", today).slice(-2)).toEqual(["2026-11-23", "2026-11-30"]);
    expect(recentPeriods("month", today).slice(0, 2)).toEqual(["2026-01", "2026-02"]);
    expect(recentPeriods("month", today).at(-1)).toBe("2026-12");
  });

  test("rounds the scale up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect([0.0123, 0.3, 1, 1.14, 2.6, 740].map(niceCeiling)).toEqual([0.02, 0.5, 1, 2, 5, 1000]);
  });

  test("keeps the busiest models' colours and folds the rest into Other", () => {
    const row = (model: string, requests: number) => ({ period: "2026-11-30", provider: "p", model, requests, failed: 0, cost: null, priced: 0 });
    const { series, columns } = stacks([row("a", 1), row("b", 9), row("c", 5), row("d", 3), row("e", 2)], ["2026-11-29", "2026-11-30"]);
    expect(series.map(({ name, slot }) => [name, slot])).toEqual([
      ["b", 0],
      ["c", 1],
      ["d", 2],
      ["Other", "other"],
    ]);
    expect(columns[0]!.parts.every(({ sum }) => sum.requests === 0)).toBe(true);
    expect(columns[1]!.parts.at(-1)!.sum.requests).toBe(3);
  });
});
