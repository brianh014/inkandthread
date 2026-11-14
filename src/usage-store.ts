import { Database } from "bun:sqlite";
import { chosenModels } from "./graph-builder";
import type { ImageAdapter } from "./image-adapter";
import { errorFields, log } from "./logger";
import type { SettingsStore } from "./settings-store";
import type { TextProvider, TextUsage } from "./turn-engine";

export type UsagePeriod = "day" | "week" | "month";
/** One AI request. Settings values and numbers only, never a word of the story. */
type Request = {
  kind: "text" | "image";
  provider: string;
  model: string;
  failed: boolean;
  tokensIn?: number;
  tokensOut?: number;
  cached?: number;
  cost?: number;
  /** What a request already counted reported later, such as a cut-off reply's cost, so it adds no request. */
  late?: boolean;
};

type Row = {
  kind: string;
  period: string;
  provider: string;
  model: string;
  requests: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  cost: number | null;
  priced: number;
};

const GROUPED: Record<UsagePeriod, string> = {
  day: "day",
  // The Monday of its week.
  week: "date(day, 'weekday 0', '-6 days')",
  month: "substr(day, 1, 7)",
};

/** Usage: a tally of AI requests by day, provider and model, in one file for every Save, so no Save's copy, import or delete touches it. */
export function usageStore(path = ":memory:") {
  const open = (at: string) => {
    const db = new Database(at, { create: true, strict: true });
    try {
      db.run(`PRAGMA synchronous = ${process.env.NODE_ENV === "test" ? "OFF" : "NORMAL"};
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        requests INTEGER NOT NULL, failed INTEGER NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
        cached INTEGER NOT NULL, cost REAL, priced INTEGER NOT NULL,
        PRIMARY KEY (day, kind, provider, model))`);
      return db;
    } catch (error) {
      // Or Windows holds a damaged file for the whole run.
      db.close();
      throw error;
    }
  };
  let db: Database;
  try {
    db = open(path);
  } catch (error) {
    // Usage is only a tally, so a file that won't open costs this run's numbers, not the app.
    log.error("usage", "Usage won't open, so this run's isn't kept", errorFields(error));
    db = open(":memory:");
  }
  // NULL cost is "none reported", so a row's cost sums only what was.
  const add =
    db.query(`INSERT INTO usage VALUES (coalesce($day, date('now', 'localtime')), $kind, $provider, $model, $requests, $failed, $tokensIn, $tokensOut, $cached, $cost, $priced)
    ON CONFLICT (day, kind, provider, model) DO UPDATE SET requests = requests + excluded.requests, failed = failed + excluded.failed,
      tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, cached = cached + excluded.cached,
      cost = CASE WHEN excluded.cost IS NULL THEN cost ELSE coalesce(cost, 0) + excluded.cost END, priced = priced + excluded.priced`);

  return {
    /** `day` is for tests; the app stamps the local date. */
    record(request: Request, day?: string) {
      const { kind, provider, model, failed, tokensIn = 0, tokensOut = 0, cached = 0, cost, late } = request;
      try {
        add.run({
          day: day ?? null,
          requests: late ? 0 : 1,
          kind,
          provider,
          model,
          failed: failed ? 1 : 0,
          tokensIn,
          tokensOut,
          cached,
          cost: cost ?? null,
          priced: cost === undefined ? 0 : 1,
        });
      } catch (error) {
        // A tally must never fail a Turn or a picture.
        log.warning("usage", "A request wasn't counted", errorFields(error));
      }
    },
    summary(by: UsagePeriod) {
      const rows = db
        .query(`SELECT ${GROUPED[by]} AS period, kind, provider, model, sum(requests) AS requests, sum(failed) AS failed,
          sum(tokens_in) AS tokensIn, sum(tokens_out) AS tokensOut, sum(cached) AS cached, sum(cost) AS cost, sum(priced) AS priced
          FROM usage GROUP BY 1, 2, 3, 4 ORDER BY period DESC, requests DESC`)
        .all() as Row[];
      // Allowlisted fields, the token ones only for text.
      return {
        text: rows.filter((row) => row.kind === "text").map(({ kind, ...row }) => row),
        images: rows
          .filter((row) => row.kind === "image")
          .map(({ period, provider, model, requests, failed, cost, priced }) => ({ period, provider, model, requests, failed, cost, priced })),
      };
    },
  };
}
export type UsageStore = ReturnType<typeof usageStore>;

/** The player's Stop and a page that left abort with no reason of the app's; one the app gives, such as a runaway, is a failure. */
const failedFor = (signal: AbortSignal) => !signal.aborted || typeof signal.reason === "string";

/** Counts every text call, whatever it's for. */
export function countedText(provider: TextProvider, usage: UsageStore, settings: SettingsStore): TextProvider {
  return async (prompt, request) => {
    let host = "";
    let textModel = "";
    try {
      const current = settings.read();
      textModel = current.textModel;
      host = current.textBaseUrl;
      host = new URL(host).host;
    } catch {
      // Settings that won't read are the provider's to fail on, and an address that won't parse is shown as typed.
    }
    const counted = (reported: TextUsage | undefined, failed: boolean, late = false) =>
      usage.record({
        kind: "text",
        provider: host,
        model: textModel,
        failed,
        late,
        tokensIn: reported?.prompt_tokens,
        tokensOut: reported?.completion_tokens,
        cached: reported?.prompt_tokens_details?.cached_tokens,
        cost: typeof reported?.cost === "number" ? reported.cost : undefined,
      });
    let seen: TextUsage | undefined;
    let done = false;
    let failed = false;
    try {
      // Usage that comes after the call ended, as a cut-off reply's can, adds to the request already counted.
      const onUsage = (reported: TextUsage) => {
        if (done) counted(reported, false, true);
        else seen = reported;
      };
      return await provider(prompt, { ...request, onUsage });
    } catch (error) {
      failed = failedFor(request.signal);
      throw error;
    } finally {
      done = true;
      counted(seen, failed);
    }
  };
}

/** Counts every picture an adapter is asked for. */
export function countedImages<P extends string>(adapters: Record<P, ImageAdapter>, usage: UsageStore, settings: SettingsStore) {
  const model = (provider: string) => {
    try {
      const choices = settings.read();
      if (provider !== "local") return choices.imageModel;
      return choices.comfyMode === "advanced" ? "workflow" : (chosenModels(choices)[0] ?? "");
    } catch {
      // Settings that won't read are the adapter's to fail on, not the tally's.
      return "";
    }
  };
  return Object.fromEntries(
    Object.entries<ImageAdapter>(adapters).map(([provider, adapter]) => [
      provider,
      (async (payload, signal) => {
        // Before the picture, as it's the model asked for.
        const asked = model(provider);
        let cost: number | undefined;
        let failed = false;
        try {
          return await adapter(payload, signal, (reported) => (cost = reported));
        } catch (error) {
          failed = failedFor(signal);
          throw error;
        } finally {
          usage.record({ kind: "image", provider, model: asked, failed, cost });
        }
      }) satisfies ImageAdapter,
    ]),
  ) as Record<P, ImageAdapter>;
}
