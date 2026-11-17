import { z } from "zod";
import { errorType, log } from "./logger";
import { estimateTokens } from "./lore-activation";
import type { TextSettings } from "./settings-store";
import { offersDecisions } from "./web/api";

/** A yes-or-no question a decision model answers with the probability that it's true. */
export type Question = { type: "noul"; instructions: string; criteria: { true: string; false: string } };

/** Each question's probability, or undefined for one not answered: refused, missing, failed or past its time. Never throws. */
export type DecisionProvider = (
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  signal: AbortSignal,
) => Promise<{ answers: Record<string, number | undefined>; model: string }>;

/** What a request is reported to have cost, for Usage. */
export type DecisionUsage = { provider: string; model: string; failed: boolean; tokensIn?: number; cost?: number };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// A decision is meant to be quick, and a miss only lets the reply through, so there's no retry.
const ANSWER_MS = 3_000;
const LIST_MS = 15_000;
// Below this a model can't hold a reply and its question, as Clef's 1,800 tokens can't.
export const MIN_CONTEXT = 8_000;
// When a listing gives no size, as the smallest of the models the trial found useful.
const ASSUMED_CONTEXT = 32_000;

/** The Consistency model's server, key and model: the Narrator's server and key, or its own. */
export function decisionServer(settings: TextSettings) {
  const all = settings.read();
  // Settings shows "Same provider" only for a Narrator's provider with decision models, so for any other it's off.
  const same = all.consistencySameProvider && offersDecisions(all.textBaseUrl);
  const [url, key] = same ? [all.textBaseUrl, all.textApiKey] : [all.consistencyBaseUrl, all.consistencyApiKey];
  return { url: url.replace(/\/$/, ""), key, model: all.consistencyModel };
}

const keyHeader = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

// shortcut: the fields are as OpenRouter's and NanoGPT's docs give them, unchecked against a real listing; if sizes come out wrong, look there.
const DecisionModels = z.object({
  data: z.array(z.object({ id: z.string(), context_length: z.number().positive().nullish().catch(null) })),
});

/** The decision models on the Consistency model's server, each with its listed size, leaving out those too small to use. Empty if it can't say. */
export async function decisionModels(settings: TextSettings, signal: AbortSignal) {
  const { url, key } = decisionServer(settings);
  if (!offersDecisions(url)) return [];
  try {
    const response = await fetch(`${url}/models?output_modalities=decisions`, {
      headers: keyHeader(key),
      signal: AbortSignal.any([signal, AbortSignal.timeout(LIST_MS)]),
    });
    if (!response.ok) return [];
    const { data } = DecisionModels.parse(await response.json());
    return data.map(({ id, context_length }) => ({ id, context: context_length ?? ASSUMED_CONTEXT })).filter(({ context }) => context >= MIN_CONTEXT);
  } catch {
    return [];
  }
}

const Answers = z.object({
  answers: z.record(z.string(), z.object({ type: z.string(), noul: z.number().min(0).max(1).optional() }).catch({ type: "unreadable" })).catch({}),
  // OpenRouter's is exact. NanoGPT's is an estimate unless asked to wait for billing, which would hold up every Turn.
  usage: z.object({ input_tokens: z.number().optional(), cost: z.number().optional(), estimated_cost: z.number().optional() }).optional(),
});

/** The one Decision Provider, using the Settings at the time of each request. `onUsage` hears each request's cost. */
export function decisionProvider(settings: TextSettings, onUsage: (usage: DecisionUsage) => void = () => {}): DecisionProvider {
  // The size each model's listing gives, looked up once per model, so a slice can be trimmed to fit.
  const sizes = new Map<string, number>();
  const sizeOf = async (model: string, signal: AbortSignal) => {
    if (!sizes.has(model)) {
      const listed = await decisionModels(settings, signal);
      // Not kept when the list didn't answer, so the next request asks again.
      if (listed.length === 0) return ASSUMED_CONTEXT;
      sizes.set(model, listed.find(({ id }) => id === model)?.context ?? ASSUMED_CONTEXT);
    }
    return sizes.get(model)!;
  };
  return async (state, questions, signal) => {
    const { url, key, model } = decisionServer(settings);
    const none = { answers: {}, model };
    if (!model || !offersDecisions(url)) return none;
    // shortcut: a slice too big is skipped, as the first questions hold no older context to drop; trim oldest first once a slice holds some.
    const limit = await sizeOf(model, signal);
    if (estimateTokens(JSON.stringify({ state, questions })) > limit) {
      log.warning("consistency", "Decision skipped as too big for the model", { model, limit });
      return none;
    }
    const address = url.includes("openrouter.ai") ? `${url.replace(/\/v1$/, "/alpha")}/decisions` : `${url}/decisions`;
    let failed = true;
    let tokensIn: number | undefined;
    let cost: number | undefined;
    try {
      const response = await fetch(address, {
        method: "POST",
        headers: { ...keyHeader(key), "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_MS)]),
      });
      if (!response.ok) {
        log.warning("consistency", "Decision request failed", { model, status: response.status });
        await response.body?.cancel();
        return none;
      }
      const { answers, usage } = Answers.parse(await response.json());
      failed = false;
      tokensIn = usage?.input_tokens;
      cost = usage?.cost ?? usage?.estimated_cost;
      // A refusal or a missing answer is "not answered", never a pass or a fail.
      return {
        answers: Object.fromEntries(Object.keys(questions).map((name) => [name, answers[name]?.type === "noul" ? answers[name].noul : undefined])),
        model,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      log.warning("consistency", "Decision request failed", { model, ...errorType(error) });
      return none;
    } finally {
      onUsage({ provider: hostOf(url), model, failed, tokensIn, cost });
    }
  };
}
