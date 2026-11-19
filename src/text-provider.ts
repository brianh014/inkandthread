import { z } from "zod";
import { commandReply } from "./command-provider";
import { errorFields, log } from "./logger";
import { type SettingsStore, type TextSettings, usesCommand } from "./settings-store";
import { ContentRefused, ReplyCutOff, StoppedOnPurpose, type TextProvider, TextProviderFailed, type TextUsage, ThoughtTooLong } from "./turn-engine";
import { GOOGLE_URL, NANOGPT_URL } from "./web/api";

// The player sees these with a retry hint after them, so none ends in a full stop.
const UNREACHABLE = "The Text Provider can't be reached, so make sure it's running and that its address in Settings is right";
const STOPPED = "The Text Provider stopped responding, so make sure it isn't stuck or still loading a model";
const TOO_LONG = "The Narrator's reply ran far too long and was stopped, so nothing was saved";
const THOUGHT_TOO_LONG = "The AI thought for too long without writing and was stopped, so nothing was saved";
const REJECTED = "The Text Provider returned an error, so look over its address, the text model and any API key in Settings";

const LIMITS = {
  // Generous, as a local server can spend minutes loading a model before its first byte.
  silenceMs: 10 * 60 * 1000,
  // A hosted API has no model to load and streams its thinking, so this long with nothing from it is a stuck request. Real
  // replies have taken six minutes, but streamed text the whole time.
  hostedSilenceMs: 2 * 60 * 1000,
  // The list is only a nicety, so a server too busy to answer holds up a Turn or Settings this long at most.
  listMs: 15 * 1000,
};

// shortcut: a shorter echo, such as a few words of player input, passes this, drop provider text altogether if one is seen.
const ECHO_CHARS = 16;

type ProviderError = { metadata?: { error_type?: string; reasons?: string[] } };

type Chunk = {
  id?: string;
  provider?: string;
  usage?: TextUsage;
  error?: ProviderError;
  choices?: {
    // OpenRouter streams thinking as `reasoning`; llama.cpp and others as `reasoning_content`.
    delta?: { content?: string | null; refusal?: string | null; reasoning?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }[];
};

// `reasons` marks a moderation error.
const isRefusal = (error?: ProviderError) => ["refusal", "content_policy_violation"].includes(error?.metadata?.error_type ?? "") || !!error?.metadata?.reasons;

async function* eventData(body: ReadableStream, onRead: () => void) {
  let pending = "";
  for await (const part of body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + part).split("\n");
    pending = lines.pop()!;
    // Anything else is a blank line or a comment, such as OpenRouter's keep-alive, which a stuck upstream sends forever, so it
    // never counts as hearing from the model.
    for (const line of lines)
      if (line.startsWith("data:")) {
        onRead();
        yield line.slice("data:".length).trim();
      }
  }
  if (pending.startsWith("data:")) yield pending.slice("data:".length).trim();
}

const keyHeader = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

// A provider's tag is its slug, then sometimes a variant, such as `deepinfra/fp8`.
const HostList = z.object({
  data: z.object({
    endpoints: z.array(
      z.object({
        provider_name: z.string(),
        tag: z.string(),
      }),
    ),
  }),
});

// `supported_parameters` is OpenRouter's, and a local server may put anything there or nothing.
const ModelList = z.object({
  data: z.array(z.object({ id: z.string(), supported_parameters: z.array(z.string()).catch([]) })),
});

// NanoGPT's detailed listing, which says which models think under `capabilities` instead.
const CapabilityList = z.object({
  data: z.array(z.object({ id: z.string(), capabilities: z.object({ reasoning: z.boolean().catch(false) }).catch({ reasoning: false }) })),
});

const GoogleModel = z.object({ thinking: z.boolean().catch(false) });
// By host, as each provider's own address names it, so a fake server can stand in by its path.
const onHost = (provider: string) => (url: string) => url.includes(new URL(provider).host);
const isGoogle = onHost(GOOGLE_URL);
const isNanoGpt = onHost(NANOGPT_URL);

/** The answer at `url`, or undefined without a usable one. */
async function list<T>(url: string, shape: z.ZodType<T>, headers: Record<string, string>, signal: AbortSignal, listMs: number) {
  try {
    const limited = AbortSignal.any([signal, AbortSignal.timeout(listMs)]);
    const response = await fetch(url, { headers, signal: limited });
    return response.ok ? shape.parse(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

const listModels = async (url: string, headers: Record<string, string>, signal: AbortSignal, listMs: number) =>
  (await list(`${url}/models`, ModelList, headers, signal, listMs))?.data;

/** The ids of the models on the saved server, empty if it doesn't list any. */
export async function textModels(settings: TextSettings, signal: AbortSignal) {
  const { textBaseUrl, textApiKey } = settings.read();
  const models = await listModels(textBaseUrl.replace(/\/$/, ""), keyHeader(textApiKey), signal, LIMITS.listMs);
  // Google's OpenAI-compatible list names each model `models/…`, and its chat takes the bare id.
  return models?.map(({ id }) => id.replace(/^models\//, "")) ?? [];
}

// Goes into a path sent with the key, so nothing that could climb out of it.
const MODEL_ID = /^\w[\w.-]*\/\w[\w.:-]*$/;

/** Who hosts a model on the saved server, each once. Empty if it can't say. */
export async function textHosts(settings: SettingsStore, model: string, signal: AbortSignal) {
  if (!MODEL_ID.test(model)) return [];
  const { textBaseUrl, textApiKey } = settings.read();
  // A variant such as `:free` shares its model's page.
  const url = `${textBaseUrl.replace(/\/$/, "")}/models/${model.split(":")[0]}/endpoints`;
  const hosts = (await list(url, HostList, keyHeader(textApiKey), signal, LIMITS.listMs))?.data.endpoints ?? [];
  const bySlug = new Map(hosts.map(({ provider_name, tag }) => [tag.split("/")[0]!, provider_name]));
  return [...bySlug].map(([slug, name]) => ({ slug, name }));
}

type Routing = Pick<ReturnType<SettingsStore["read"]>, "textRouting" | "textHost" | "textHostFallback">;

// Each host keeps its own prompt cache, so one host Turn after Turn is what makes the cache pay.
const routing = ({ textRouting, textHost, textHostFallback }: Routing) =>
  textHost ? { order: [textHost], allow_fallbacks: textHostFallback } : textRouting === "default" ? {} : { sort: textRouting };

/** The one Text Provider: any OpenAI-compatible server, using the Settings at the time of each call. */
const LEVELS = ["low", "medium", "high"];
/** `steps` levels below `level`, and never below Low. The model's own level is taken as one that thinks too long, so it goes to Low. */
const lowerThinking = (level: string, steps: number) => LEVELS[Math.max(0, LEVELS.indexOf(level) - steps)] ?? "low";

export function textProvider(
  settings: TextSettings,
  { silenceMs, hostedSilenceMs = silenceMs, listMs }: { silenceMs: number; hostedSilenceMs?: number; listMs: number } = LIMITS,
): TextProvider {
  const schemaSupport = new Map<string, boolean>();
  // Whether a model takes `reasoning`, by its provider's listing, or false after it refused one. Sent to a model that doesn't, on
  // OpenRouter it would leave a schema call, which requires every parameter, no host.
  const thinks = new Map<string, boolean>();
  // Servers that refused `stream_options`, so they aren't asked again until the app restarts.
  const usageRefused = new Set<string>();

  async function supportsSchema(url: string, model: string, headers: Record<string, string>, signal: AbortSignal) {
    const known = schemaSupport.get(`${url} ${model}`);
    if (known !== undefined) return known;
    // Only OpenRouter's listing says which models take a schema, so any other server is tried, and a refusal turns it off as below.
    if (!url.includes("openrouter.ai")) return true;
    const models = await listModels(url, headers, signal, listMs);
    // Without an answer, JSON validation and retries still work, so ask again on the next call.
    if (!models) return false;
    const params = models.find(({ id }) => id === model)?.supported_parameters ?? [];
    const supported = params.includes("structured_outputs");
    schemaSupport.set(`${url} ${model}`, supported);
    if (!thinks.has(`${url} ${model}`)) thinks.set(`${url} ${model}`, params.includes("reasoning"));
    return supported;
  }

  /**
   * Whether a model's provider says it thinks, from OpenRouter's, NanoGPT's or Google's listing. Any other server, such as a
   * local one, is never sent a Thinking level, as the setting isn't shown for it. NanoGPT and Google are asked once, as a
   * failed lookup would otherwise delay every call: without an answer, no level is sent until the app restarts. OpenRouter's
   * comes with the schema lookup, which asks again on the next call, and `listed` says this call already asked.
   */
  async function takesReasoning(url: string, model: string, apiKey: string, headers: Record<string, string>, signal: AbortSignal, listed: boolean) {
    const key = `${url} ${model}`;
    const known = thinks.get(key);
    if (known !== undefined) return known;
    let takes: boolean | undefined;
    if (url.includes("openrouter.ai")) {
      if (!listed) await supportsSchema(url, model, headers, signal);
      return thinks.get(key) ?? false;
    } else if (isGoogle(url)) {
      // Google's OpenAI-compatible list says nothing of thinking, but its own API does, and takes the key in its own header.
      const found = await list(
        `${url.replace(/\/openai$/, "")}/models/${encodeURIComponent(model)}`,
        GoogleModel,
        { "x-goog-api-key": apiKey },
        signal,
        listMs,
      );
      takes = found?.thinking;
    } else if (isNanoGpt(url)) {
      const models = (await list(`${url}/models?detailed=true`, CapabilityList, headers, signal, listMs))?.data;
      takes = models && !!models.find(({ id }) => id === model)?.capabilities.reasoning;
    } else return false;
    if (takes === undefined) log.warning("text", "Thinking level not sent", { model, reason: "the provider's model list didn't answer" });
    thinks.set(key, takes ?? false);
    return takes ?? false;
  }

  return async (prompt, request) => {
    const all = settings.read();
    if (usesCommand(all)) return commandReply(prompt, request, all);
    const { schema, picture, lessThinking = 0, onText, onGeneration, onUsage, signal } = request;
    const {
      textBaseUrl,
      textApiKey,
      textModel,
      textMaxTokens,
      textReplyMinutes,
      textThinking: chosenThinking,
      textThinkingTokens,
      pictureThinkingTokens,
      ...chosen
    } = all;
    const textThinking = lessThinking ? lowerThinking(chosenThinking, lessThinking) : chosenThinking;
    const thinkingTokens = picture ? pictureThinkingTokens : textThinkingTokens;
    if (!textModel) throw new TextProviderFailed("No text model is set, so choose one in Settings");
    const url = textBaseUrl.replace(/\/$/, "");
    const openRouter = url.includes("openrouter.ai");
    // shortcut: https stands for a hosted API, as local servers run on http; a self-hosted server behind https that loads models
    // slowly gets the hosted limit too, give it a setting if a player hits that.
    const quiet = url.startsWith("https:") ? hostedSilenceMs : silenceMs;
    const headers = keyHeader(textApiKey);
    const sent = prompt.map(({ content }) => content).join("\n");
    // A provider may echo what it was sent, and this text goes to the Server Log at Verbose, so no key and nothing of the prompt.
    const unkeyed = (text: string) => (textApiKey ? text.replaceAll(textApiKey, "[key]") : text);
    const redacted = (detail: string) => {
      const short = unkeyed(detail).slice(0, 300);
      for (let at = 0; at + ECHO_CHARS <= short.length; at++) if (sent.includes(short.slice(at, at + ECHO_CHARS))) return "[it repeats the prompt]";
      return short;
    };
    // Story in log is the one place a log holds story text, as the player chose it for debugging. Never the key, should the text hold it.
    if (chosen.storyInLog) log.story("text", "Prompt text", { prompt: prompt.map(({ role, content }) => ({ role, content: unkeyed(content) })) });
    const failure = (error: ProviderError | undefined, status: number) => {
      if (isRefusal(error)) return new ContentRefused();
      log.verbose("text", "Text Provider error", () => ({ detail: redacted(JSON.stringify({ status, error })) }));
      return new TextProviderFailed(REJECTED);
    };

    // For the Server Log, so it holds how the reply went and none of its text.
    const started = Date.now();
    const seen: Record<string, unknown> = { model: textModel, thinking: textThinking, thinkingLimit: thinkingTokens };
    let reply = "";
    let thought = 0;

    const silence = new AbortController();
    let timer: Timer | undefined;
    // A model can stream forever without falling silent, so a reply also has a time limit.
    const overrun = new AbortController();
    let deadline: Timer | undefined;
    const heardFrom = () => {
      clearTimeout(timer);
      timer = setTimeout(() => silence.abort(), quiet);
    };

    let withThinking = false;
    const send = async (useSchema: boolean, askUsage: boolean) => {
      heardFrom();
      log.verbose("text", "Prompt sent", () => ({ model: textModel, messages: prompt.length, chars: sent.length, schema: useSchema }));
      const response = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, silence.signal, overrun.signal]),
        // Bun's own limit would otherwise end a slow first response before ours.
        timeout: false,
        body: JSON.stringify({
          model: textModel,
          messages: prompt,
          stream: true,
          // OpenRouter reports usage anyway; other servers, Google's and local ones among them, only when asked.
          ...(askUsage && { stream_options: { include_usage: true } }),
          max_tokens: textMaxTokens,
          // Changes nothing in the prompt, so the provider's cache still holds. Google takes only OpenAI's own field.
          ...(withThinking && (isGoogle(url) ? { reasoning_effort: textThinking } : { reasoning: { effort: textThinking } })),
          ...(useSchema && { response_format: { type: "json_schema", json_schema: { name: "narrator_response", strict: true, schema } } }),
          // OpenRouter only: a strict server such as OpenAI refuses a field it does not know.
          ...(openRouter && { provider: { ...(useSchema && { require_parameters: true }), ...routing(chosen) } }),
        }),
      });
      heardFrom();
      return response;
    };

    try {
      const useSchema = schema !== undefined && (await supportsSchema(url, textModel, headers, signal));
      withThinking = textThinking !== "default" && (await takesReasoning(url, textModel, textApiKey, headers, signal, schema !== undefined));
      seen.schema = useSchema;
      const askUsage = !openRouter && !usageRefused.has(url);
      let response = await send(useSchema, askUsage);
      // Tried first, as a host or model that won't take the level would otherwise be read below as refusing the schema, which then goes for good.
      if (withThinking && (response.status === 400 || response.status === 404)) {
        await response.body?.cancel();
        withThinking = false;
        const status = response.status;
        response = await send(useSchema, askUsage);
        if (response.ok) {
          log.warning("text", "Thinking level refused", { model: textModel, thinking: textThinking, status });
          thinks.set(`${url} ${textModel}`, false);
        }
      }
      seen.thinkingSent = withThinking;
      // A tally must never fail a Turn, so a server that won't take the ask for usage is sent the prompt without it.
      if (askUsage && (response.status === 400 || response.status === 422)) {
        await response.body?.cancel();
        response = await send(useSchema, false);
        if (response.ok) {
          log.warning("text", "Usage ask refused", { model: textModel });
          usageRefused.add(url);
        }
      }
      // A listing can claim schema support that the routed provider then rejects, and that must not fail every Turn.
      if (useSchema && (response.status === 400 || response.status === 404)) {
        log.warning("text", "Schema mode rejected", { model: textModel, status: response.status });
        const detail = await response.text();
        log.verbose("text", "Schema mode rejection", () => ({ detail: redacted(detail) }));
        schemaSupport.set(`${url} ${textModel}`, false);
        seen.schema = false;
        response = await send(false, false);
      }
      seen.status = response.status;
      if (!response.ok || !response.body) {
        const { error } = (await response.json().catch(() => ({}))) as Chunk;
        throw failure(error, response.status);
      }

      // Some servers ignore `stream` and send the whole reply as one JSON body.
      const whole = response.headers.get("content-type")?.includes("application/json");
      for await (const data of whole ? [await response.text()] : eventData(response.body, heardFrom)) {
        if (data === "[DONE]") break;
        // A body that came in one piece is all read before fetch sees an abort, so a caller's stop must end it here.
        signal.throwIfAborted();
        deadline ??= setTimeout(() => overrun.abort(), textReplyMinutes * 60 * 1000);
        seen.lines = ((seen.lines as number) ?? 0) + 1;
        // Enough to tell cut-off JSON from an HTML page, and it can't hold a word of the story.
        seen.last = { chars: data.length, first: data[0], final: data.at(-1) };
        const { id, provider, usage, error, choices } = JSON.parse(data) as Chunk;
        delete seen.last;
        if (id && id !== seen.generation) onGeneration?.(id);
        if (error) throw failure(error, response.status);
        const { delta, message, finish_reason, native_finish_reason } = choices?.[0] ?? {};
        Object.assign(seen, {
          generation: id ?? seen.generation,
          provider: provider ?? seen.provider,
          usage: usage ?? seen.usage,
          finish: finish_reason ?? seen.finish,
          nativeFinish: native_finish_reason ?? seen.nativeFinish,
        });
        if (delta?.refusal || finish_reason === "content_filter") throw new ContentRefused();
        // A Turn retries this, as there it's mostly a model stuck in a loop. Elsewhere it fails as too long.
        if (finish_reason === "length") throw new ReplyCutOff(TOO_LONG);
        // shortcut: thinking inside <think> tags in the reply itself isn't counted, as only local servers send it that way; count it if one gets stuck.
        thought += (delta?.reasoning ?? delta?.reasoning_content ?? "").length;
        // About four characters a token, as estimateTokens counts.
        if (thought / 4 > thinkingTokens) throw new ThoughtTooLong(THOUGHT_TOO_LONG);
        const text = delta?.content ?? message?.content;
        if (text) {
          reply += text;
          onText(text);
        }
      }
      signal.throwIfAborted();
      return reply;
    } catch (cause) {
      // A caller that stops a reply for its own reason gives it in the app's own words: as a string, or as a stop on purpose.
      const reason = signal.reason instanceof StoppedOnPurpose ? signal.reason.why : signal.reason;
      seen.failed = signal.aborted ? (typeof reason === "string" ? reason : "the client left") : (cause as Error).name;
      const known = cause instanceof ContentRefused || cause instanceof TextProviderFailed;
      if (known || signal.aborted || cause instanceof SyntaxError) throw cause;
      throw new TextProviderFailed(overrun.signal.aborted ? TOO_LONG : silence.signal.aborted ? STOPPED : UNREACHABLE, { cause });
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      const logAs = seen.failed && !signal.aborted ? log.warning : log.info;
      logAs("text", "Text reply", () => ({ ...seen, chars: reply.length, thoughtChars: thought, ms: Date.now() - started }));
      // Usage comes in the last chunk, so a reply cut off, refused or stopped part-way has none, though it's billed. OpenRouter keeps it by the reply's id.
      if (seen.usage) onUsage?.(seen.usage as TextUsage);
      else if (openRouter && onUsage && typeof seen.generation === "string")
        void generationUsage(url, seen.generation, headers).then((found) => found && onUsage(found));
      if (chosen.storyInLog && reply) log.story("text", "Text reply text", { text: unkeyed(reply) });
    }
  };
}

type Generation = { total_cost?: number; native_tokens_prompt?: number; native_tokens_completion?: number; native_tokens_cached?: number };

/**
 * A reply's usage from OpenRouter's record of it, for one that ended before its last chunk. The record takes a moment to
 * appear, so it asks a few times. Never throws, as only Usage waits on it.
 * shortcut: the fields are as OpenRouter's /generation docs give them, unchecked against a real reply; if a cut-off reply shows no cost, look there.
 */
async function generationUsage(url: string, id: string, headers: Record<string, string>): Promise<TextUsage | undefined> {
  for (const wait of [2_000, 5_000, 15_000]) {
    // Unref'd, so a lookup still waiting never holds the app (or a test run) open.
    await new Promise((done) => setTimeout(done, wait).unref());
    try {
      const response = await fetch(`${url}/generation?id=${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const { data } = (await response.json()) as { data?: Generation };
      if (typeof data?.total_cost !== "number") continue;
      return {
        prompt_tokens: data.native_tokens_prompt,
        completion_tokens: data.native_tokens_completion,
        prompt_tokens_details: { cached_tokens: data.native_tokens_cached },
        cost: data.total_cost,
      };
    } catch (error) {
      log.verbose("text", "Reply usage not found yet", () => ({ generation: id, ...errorFields(error) }));
    }
  }
  return undefined;
}
