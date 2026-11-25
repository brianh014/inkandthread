import { Database } from "bun:sqlite";
import { chosenModels } from "./graph-builder";
import type { ImageAdapter } from "./image-adapter";
import { errorFields, log } from "./logger";
import { modelName, type SettingsStore, type TextSettings, usesCommand } from "./settings-store";
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

/** A player's Turn as the Narrator answered it: the Check's difficulty if one was rolled, and the names of its state operations. Never a word of the story. */
export type NarratorTurn = { difficulty?: "Easy" | "Moderate" | "Hard" | "Very Hard"; operations: string[] };

/** The operations each count adds up, by the column it goes in. */
const COUNTED: Record<string, string[]> = {
  time_moved: ["set_story_time"],
  scenes: ["set_scene"],
  facts: ["add_known_fact", "update_known_fact"],
  loose_opened: ["add_loose_end"],
  loose_closed: ["resolve_loose_end"],
  // A Turn adds and ends none now, but a file from before has these columns, which an insert must fill.
  threads_added: [],
  threads_moved: ["update_plot_thread"],
  threads_resolved: [],
};
const DIFFICULTIES = { Easy: "easy", Moderate: "moderate", Hard: "hard", "Very Hard": "very_hard" } as const;

export type NarratorRow = {
  save: string;
  model: string;
  turns: number;
  checks: number;
  easy: number;
  moderate: number;
  hard: number;
  veryHard: number;
  unchanged: number;
  timeMoved: number;
  scenes: number;
  facts: number;
  looseOpened: number;
  looseClosed: number;
  threadsMoved: number;
  sinceCheck: number;
  sinceTime: number;
  /** Whether this is the model the story last played with, the only row whose counts since still mean anything. */
  latest: boolean;
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
        PRIMARY KEY (day, kind, provider, model));
      CREATE TABLE IF NOT EXISTS narrator (
        save TEXT NOT NULL, model TEXT NOT NULL, turns INTEGER NOT NULL, checks INTEGER NOT NULL,
        easy INTEGER NOT NULL, moderate INTEGER NOT NULL, hard INTEGER NOT NULL, very_hard INTEGER NOT NULL, unchanged INTEGER NOT NULL,
        ${Object.keys(COUNTED)
          .map((column) => `${column} INTEGER NOT NULL`)
          .join(", ")},
        since_check INTEGER NOT NULL, since_time INTEGER NOT NULL, last INTEGER NOT NULL,
        PRIMARY KEY (save, model))`);
      // A file from a build of this branch before `last` was added.
      if (!db.query("SELECT 1 FROM pragma_table_info('narrator') WHERE name = 'last'").get())
        db.run("ALTER TABLE narrator ADD COLUMN last INTEGER NOT NULL DEFAULT 0");
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
  const summed = ["turns", "checks", ...Object.values(DIFFICULTIES), "unchanged", ...Object.keys(COUNTED)];
  // A count since resets to 0 on the Turn that has the thing, and otherwise grows by one. `last` orders rows by the Turn that
  // last touched them, so a story's current model is known.
  const addTurn = db.query(`INSERT INTO narrator VALUES ($save, $model, ${summed.map((column) => `$${column}`).join(", ")}, $since_check, $since_time,
      (SELECT coalesce(max(last), 0) + 1 FROM narrator))
    ON CONFLICT (save, model) DO UPDATE SET ${summed.map((column) => `${column} = ${column} + excluded.${column}`).join(", ")},
      since_check = CASE WHEN excluded.checks > 0 THEN 0 ELSE since_check + 1 END,
      since_time = CASE WHEN excluded.time_moved > 0 THEN 0 ELSE since_time + 1 END, last = excluded.last`);
  const reverted = db.query("UPDATE narrator SET since_check = 0, since_time = 0 WHERE save = ?");

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
    /** Counts one player's Turn for its Save and the text model that wrote it. */
    turn(save: string, model: string, { difficulty, operations }: NarratorTurn) {
      const times = (names: string[]) => operations.filter((op) => names.includes(op)).length;
      const counts = Object.fromEntries(Object.entries(COUNTED).map(([column, names]) => [column, times(names)]));
      try {
        addTurn.run({
          save,
          model,
          turns: 1,
          checks: difficulty ? 1 : 0,
          ...Object.fromEntries(Object.entries(DIFFICULTIES).map(([name, column]) => [column, difficulty === name ? 1 : 0])),
          unchanged: operations.length === 0 ? 1 : 0,
          ...counts,
          since_check: difficulty ? 0 : 1,
          since_time: counts.time_moved ? 0 : 1,
        });
      } catch (error) {
        log.warning("usage", "A Turn wasn't counted", errorFields(error));
      }
    },
    /**
     * After a Revert, the Turns it took out stay counted, as they were played, but how long it's been since a Check or since
     * time moved can't be known, so both start again. shortcut: there's no per-Turn record to take counts back; keep one if exact totals matter.
     */
    reverted(save: string) {
      try {
        reverted.run(save);
      } catch (error) {
        log.warning("usage", "A Revert wasn't noted in the Narrator counts", errorFields(error));
      }
    },
    /** Every Save's counts for each model that wrote in it, a story's rows together, the most played story first. */
    narrator() {
      return (
        db
          .query(`SELECT save, model, turns, checks, easy, moderate, hard, very_hard AS veryHard, unchanged, time_moved AS timeMoved, scenes, facts,
          loose_opened AS looseOpened, loose_closed AS looseClosed, threads_moved AS threadsMoved,
          since_check AS sinceCheck, since_time AS sinceTime, last = max(last) OVER (PARTITION BY save) AS latest
          FROM narrator ORDER BY sum(turns) OVER (PARTITION BY save) DESC, save, last DESC`)
          .all() as (Omit<NarratorRow, "latest"> & { latest: number })[]
      ).map((row) => ({ ...row, latest: row.latest === 1 }));
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

/** The player's Stop, a page that left and a stop on purpose aren't failures; a reason the app gives, such as a runaway, is. */
const failedFor = (signal: AbortSignal) => !signal.aborted || typeof signal.reason === "string";

/** Counts every text call, whatever it's for. */
export function countedText(provider: TextProvider, usage: UsageStore, settings: TextSettings): TextProvider {
  return async (prompt, request) => {
    let host = "";
    let textModel = "";
    try {
      const current = settings.read();
      textModel = modelName(current);
      host = usesCommand(current) ? "command" : current.textBaseUrl;
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
