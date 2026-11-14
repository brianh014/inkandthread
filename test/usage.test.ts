import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { settingsStore } from "../src/settings-store";
import { countedImages, countedText, usageStore } from "../src/usage-store";
import { niceCeiling, recentPeriods, stacks } from "../src/web/usage";
import { png, startApp, tempFolder } from "./support";

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

  test("counts a text call that throws as failed, but not one the player stopped", async () => {
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

    const [row] = usage.summary("day").text;
    expect(row).toMatchObject({ provider: "openrouter.ai", model: "m", requests: 3, failed: 2, tokensIn: 21, cost: 1.5, priced: 3 });
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
