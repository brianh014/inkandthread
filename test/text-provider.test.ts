import { messageBeats } from "../src/web/chat-style";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { introduce } from "../src/state-applier";
import { textProvider } from "../src/text-provider";
import {
  peopleLeftOut,
  speechOutsideLines,
  spokenLineFault,
  ThinkingBudgetReached,
  type TextProvider,
  usableChoices,
  usableOperations,
  withKnownSpeakers,
  withoutJsonTail,
  withoutLoop,
} from "../src/turn-engine";
import { delta, fakeOpenAi, logOf, scriptedDice, startApp, tempFolder, turnEvents } from "./support";

let folder: ReturnType<typeof tempFolder>;
let app: ReturnType<typeof startApp>;
let provider: ReturnType<typeof fakeOpenAi>;

const narrated = (text: string, ...state_operations: unknown[]) => [
  delta(JSON.stringify({ check: null, narration: text, state_operations })),
  "data: [DONE]\n\n",
];

/** The real client against a fake server. */
function play(replies: Parameters<typeof fakeOpenAi>[0], models?: unknown, dice = scriptedDice(), openRouter = false) {
  provider = fakeOpenAi(replies, models);
  const savesDir = join(folder.path, "Saves");
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textBaseUrl: openRouter ? provider.openRouterUrl : provider.baseUrl, textApiKey: "test-key", textModel: "fake/model" });
  app = startApp(savesDir, textProvider(settings), dice);
  return app;
}

const streamTurn = (id: string, input: string, signal?: AbortSignal) =>
  fetch(app.url(`/saves/${id}/turns`), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ input }),
    signal,
  });

const storedMessages = async (id: string) => ((await app.get(`/saves/${id}/messages`).then((r) => r.json())) as { messages: { text: string }[] }).messages;

beforeEach(() => {
  folder = tempFolder();
});

afterEach(async () => {
  await app?.stop();
  provider?.stop();
  folder.remove();
});

test("a spoken line streams intact, even when a chunk ends inside its line break", async () => {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const text = "[Ashley]: “Hey [sic].”\n\nShe looks up.";
  const reply = JSON.stringify({ check: null, narration: text, state_operations: [] });
  const cut = reply.indexOf("\\n") + 1;
  play([
    async function* () {
      yield delta(reply.slice(0, cut));
      await released;
      yield delta(reply.slice(cut));
      yield "data: [DONE]\n\n";
    },
  ]);
  const id = await app.createSave();

  const response = await streamTurn(id, "I wave.");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value: first } = await reader.read();
  expect(first).toContain('"[Ashley]: “Hey [sic].”"');
  release();
  let rest = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += part.value;

  expect(rest).toContain(String.raw`"\n\nShe looks up."`);
  expect((await storedMessages(id)).at(-1)!.text).toBe(text);
});

test("Stop ends a running Turn: the model call is cancelled, nothing is stored, and the player's words come back", async () => {
  const { promise: never } = Promise.withResolvers<void>();
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      await never;
    },
    narrated("The tide falls."),
  ]);
  const id = await app.createSave();
  expect((await app.delete(`/saves/${id}/turn`)).status).toBe(404);

  const response = await streamTurn(id, "I wait.");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  expect((await reader.read()).value).toContain("The tide ");
  expect((await app.delete(`/saves/${id}/turn`)).status).toBe(204);
  let rest = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += part.value;

  expect(rest).toContain("event: error");
  expect(rest).toContain('"status":499');
  expect(rest).toContain('"input":"I wait."');
  expect(await storedMessages(id)).toEqual([]);
  // The Save is free again for the next Turn.
  expect((await turnEvents(await streamTurn(id, "I wait again."))).at(-1)!.event).toBe("done");
});

test("narration reaches the client as it is written, and nothing is stored until the Turn is valid", async () => {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      await released;
      yield delta('rises."}');
      yield "data: [DONE]\n\n";
    },
  ]);
  const id = await app.createSave();

  const response = await streamTurn(id, "I wade forward.");
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value: first } = await reader.read();

  expect(first).toBe('event: narration\ndata: {"text":"The tide "}\n\n');
  expect(await storedMessages(id)).toEqual([]);

  release();
  let rest = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += part.value;
  expect(rest).toContain('event: narration\ndata: {"text":"rises."}\n\n');
  expect(rest).toContain(
    `event: done\ndata: ${JSON.stringify({
      messages: [
        { id: 1, role: "player", text: "I wade forward." },
        { id: 2, role: "narrator", text: "The tide rises." },
      ],
    })}\n\n`,
  );
  expect(await storedMessages(id)).toHaveLength(2);
});

test("without the streaming Accept header a Turn still answers with plain JSON", async () => {
  play([narrated("Rain.")]);
  const id = await app.createSave();

  const response = await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(response.status).toBe(201);
  expect(((await response.json()) as { messages: unknown[] }).messages).toHaveLength(2);
});

const CHECK_REPLY = '{"check":{"action":"Leap the gap","difficulty":"Hard"},"narration":null,"state_operations":[]}';

test("a Check request shows no narration, and the result narration streams after the roll", async () => {
  play([[delta(CHECK_REPLY)], narrated("You land.")], undefined, scriptedDice(18));
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I leap the gap."));

  expect(events.map(({ event }) => event)).toEqual(["narration", "reply", "done"]);
  expect(events[0]!.data).toEqual({ text: "You land." });
  expect(JSON.stringify(provider.requests[1]!.body.messages.at(-1))).toContain("The Check is resolved");
});

test("narration written before the reply shows it is not a Check request is never shown early", async () => {
  play(
    [[delta('{"narration":"You start to leap","check":{"action":"Leap the gap","difficulty":"Hard"}}')], [delta('{"narration":"You land."}')]],
    undefined,
    scriptedDice(18),
  );
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I leap the gap."));

  // Only the result's final text, once it's checked.
  expect(events.map(({ event }) => event)).toEqual(["reply", "done"]);
  expect((await storedMessages(id)).at(-1)!.text).toBe("You land.");
});

test("a retry tells the client to discard the narration of the failed attempt", async () => {
  const refused = { op: "remove_item", item: "a key the PC does not have" };
  play([narrated("You unlock the door.", refused), narrated("The door stays shut.")]);
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I unlock the door."));

  expect(events.map(({ event }) => event)).toEqual(["narration", "restart", "narration", "reply", "done"]);
  expect(events[2]!.data).toEqual({ text: "The door stays shut." });
  expect((await storedMessages(id)).map(({ text }) => text)).toEqual(["I unlock the door.", "The door stays shut."]);
});

test("a reply that turns into a Check request after narration began restarts the client", async () => {
  play([[delta('{"check":null,"narration":"You leap","check":{"action":"Leap","difficulty":"Easy"}}')], narrated("You land.")], undefined, scriptedDice(18));
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I leap."));

  expect(events.map(({ event }) => event)).toEqual(["narration", "restart", "narration", "reply", "done"]);
});

test("escapes and multi-byte characters split across network reads reach the client intact", async () => {
  const text = 'She said "café\n\u{1F30A}" \\ end.';
  const reply = JSON.stringify({ check: null, narration: text, state_operations: [] });
  const bytes = new TextEncoder().encode(delta(reply).replaceAll("\n\n", "\r\n\r\n"));
  play([
    async function* () {
      yield ": OPENROUTER PROCESSING\n\n";
      for (let i = 0; i < bytes.length; i += 3) {
        yield bytes.slice(i, i + 3) as unknown as string;
        await Bun.sleep(0);
      }
      yield "data: [DONE]\n\n";
    },
  ]);
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I listen."));

  expect(events.at(-1)!.event).toBe("done");
  const shown = events.filter(({ event }) => event === "narration").map(({ data }) => data.text);
  expect(shown.join("")).toBe(text);
});

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const errorChunk = (error: unknown) => sse({ error, choices: [{ delta: { content: "" }, finish_reason: "error" }] });
const httpError = (error: unknown, status: number) => () => Response.json({ error }, { status });

const refusals: [string, () => Parameters<typeof fakeOpenAi>[0][number]][] = [
  ["a refusal delta", () => [sse({ choices: [{ delta: { refusal: "I cannot" } }] })]],
  ["a content_filter finish", () => [sse({ choices: [{ delta: {}, finish_reason: "content_filter" }] })]],
  ["a refusal error mid-stream", () => [errorChunk({ code: 403, metadata: { error_type: "refusal" } })]],
  ["a content policy error before the stream", httpError({ code: 403, metadata: { error_type: "content_policy_violation" } }, 403)],
  ["a moderation error", httpError({ code: 403, metadata: { reasons: ["violence"] } }, 403)],
];

test.each(refusals)("%s is reported as refused and commits nothing", async (_, refusal) => {
  play([refusal()]);
  const id = await app.createSave();

  const [first] = await turnEvents(await streamTurn(id, "Something refused."));

  expect(first).toMatchObject({ event: "error", data: { status: 422, failure: "refused", input: "Something refused." } });
  expect(await storedMessages(id)).toEqual([]);
});

test("a refusal after narration began ends in an error event, with no Turn stored", async () => {
  play([[delta('{"check":null,"narration":"You begin'), sse({ choices: [{ finish_reason: "content_filter" }] })]]);
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "Something refused."));

  expect(events.map(({ event }) => event)).toEqual(["narration", "error"]);
  expect(await storedMessages(id)).toEqual([]);
});

test("a provider error mid-stream fails the Turn as retryable, and its detail stays on the server", async () => {
  const providerError = { code: "server_error", message: "PROVIDER-DETAIL" };
  play([[delta('{"check":null,"narration":"The ti'), errorChunk(providerError)]]);
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I wade forward."));

  expect(events.at(-1)).toEqual({
    event: "error",
    data: { status: 502, error: expect.stringContaining("returned an error"), failure: "retryable", input: "I wade forward." },
  });
  expect(await storedMessages(id)).toEqual([]);
});

test("a rate limit tells the player the provider is busy, not to look over their Settings", async () => {
  play([new Response(JSON.stringify({ error: { code: 429, message: "Rate limited" } }), { status: 429 })]);
  const id = await app.createSave();

  const events = await turnEvents(await streamTurn(id, "I wade forward."));

  const { error } = events.at(-1)!.data as { error: string };
  expect(error).toContain("busy");
  expect(error).not.toContain("Settings");
});

const schemaModel = { data: [{ id: "fake/model", supported_parameters: ["structured_outputs", "response_format"] }] };

test("schema mode is used on a model that supports it", async () => {
  play([narrated("Rain.")], schemaModel, scriptedDice(), true);
  const id = await app.createSave();

  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  const { body, authorization } = provider.requests[0]!;
  expect(authorization).toBe("Bearer test-key");
  expect(body.model).toBe("fake/model");
  expect(body.stream).toBe(true);
  expect(body.provider).toEqual({ require_parameters: true, sort: "price" });
  expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
});

test.each([
  ["a routing", { textRouting: "throughput" }, { require_parameters: true, sort: "throughput" }],
  ["OpenRouter's own choice", { textRouting: "default" }, { require_parameters: true }],
  ["a named host, which wins over the routing", { textHost: "xiaomi" }, { require_parameters: true, order: ["xiaomi"], allow_fallbacks: true }],
  ["a host with no fallback", { textHost: "xiaomi", textHostFallback: false }, { require_parameters: true, order: ["xiaomi"], allow_fallbacks: false }],
] as const)("%s reaches the request", async (_, change, expected) => {
  play([narrated("Rain.")], schemaModel, scriptedDice(), true);
  settingsStore(join(folder.path, "settings.json")).update(change);
  const id = await app.createSave();

  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests[0]!.body.provider).toEqual(expected);
});

test("a server that isn't OpenRouter gets schema mode but no routing, which a strict one refuses", async () => {
  play([narrated("Rain.")], schemaModel);
  const id = await app.createSave();

  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests[0]!.body.provider).toBeUndefined();
  expect(provider.requests[0]!.body.response_format).toMatchObject({ type: "json_schema" });
});

test("a server with no schema mode isn't sent routing it may not know", async () => {
  play([narrated("Rain.")], { data: [{ id: "fake/model" }] });
  const id = await app.createSave();

  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests[0]!.body.provider).toBeUndefined();
});

test("the schema keeps to what strict schema modes accept, with check first", async () => {
  play([narrated("Rain.")], schemaModel);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  const { schema } = provider.requests[0]!.body.response_format.json_schema;

  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties)).toEqual([
    "check",
    "narration",
    "state_operations",
    "people",
    "summary",
    "recent_summary",
    "scene_changed",
    "visual_description",
    "chapter_ends",
  ]);
  expect(schema.properties.check.properties.action.description).toContain("as the player's move has the PC say or do it");
  const visit = (node: any) => {
    if (typeof node !== "object" || node === null) return;
    for (const refused of ["oneOf", "minLength", "$schema"]) expect(Object.keys(node)).not.toContain(refused);
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required.toSorted()).toEqual(Object.keys(node.properties).toSorted());
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
});

test.each([
  ["does not list structured outputs", { data: [{ id: "fake/model", supported_parameters: ["temperature"] }] }],
  ["is unknown to the server", { data: [] }],
  ["cannot be looked up", null],
])("on OpenRouter, a model that %s falls back to JSON validation and retries", async (_, models) => {
  play([[delta("not json")], narrated("Rain.")], models, scriptedDice(), true);
  const id = await app.createSave();

  const response = await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(response.status).toBe(201);
  expect(provider.requests).toHaveLength(2);
  expect(provider.requests[0]!.body.response_format).toBeUndefined();
});

test("a model whose listing claims schema support but rejects the schema still plays, without schema mode", async () => {
  const rejected = () => Response.json({ error: { code: 400, message: "Invalid schema" } }, { status: 400 });
  // Rejected again without the ask for usage, as it's the schema the server won't take.
  play([rejected(), rejected(), narrated("Rain."), narrated("Wind.")], schemaModel);
  const id = await app.createSave();

  const response = await app.post(`/saves/${id}/turns`, { input: "I wait." });
  await app.post(`/saves/${id}/turns`, { input: "I wait more." });

  expect(response.status).toBe(201);
  expect(provider.requests.map(({ body }) => !!body.response_format)).toEqual([true, true, false, false]);
  // Only the schema is given up for good.
  expect(provider.requests.map(({ body }) => !!body.stream_options)).toEqual([true, false, false, true]);
});

test("a server that refuses the ask for usage still plays, and isn't asked again", async () => {
  const refused = () => Response.json({ error: { code: 400, message: "Unknown field stream_options" } }, { status: 400 });
  play([refused(), narrated("Rain."), narrated("Wind.")]);
  const id = await app.createSave();

  const response = await app.post(`/saves/${id}/turns`, { input: "I wait." });
  await app.post(`/saves/${id}/turns`, { input: "I wait more." });

  expect(response.status).toBe(201);
  expect(provider.requests.map(({ body }) => !!body.stream_options)).toEqual([true, false, false]);
});

test("an answer without OpenRouter's model list is not remembered, so schema mode is tried again", async () => {
  play([narrated("Rain."), narrated("Wind.")], {}, scriptedDice(), true);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  provider.setModels(schemaModel);
  await app.post(`/saves/${id}/turns`, { input: "I wait more." });

  expect(provider.requests.map(({ body }) => !!body.response_format)).toEqual([false, true]);
});

test("earlier narration in the prompt shows the Narrator the key order a new reply needs", async () => {
  play([narrated("Rain."), narrated("Wind.")]);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  await app.post(`/saves/${id}/turns`, { input: "I wait more." });

  const history = provider.requests[1]!.body.messages.find(({ role }: { role: string }) => role === "assistant");

  expect(history.content).toStartWith('{"check":null,"narration":"Rain."');
});

test("the prompt reaches the provider in order, so world_rules and the Check result stay late", async () => {
  play([[delta(CHECK_REPLY)], narrated("You land.")], undefined, scriptedDice(18));
  const id = await app.createSave();

  await app.post(`/saves/${id}/turns`, { input: "I leap." });

  const messages: { role: string; content: string }[] = provider.requests[1]!.body.messages;
  expect(messages.map(({ role }) => role)).toEqual(["system", "system", "user", "system"]);
  expect(messages[1]!.content).toContain("world_rules:");
  expect(messages[2]!.content).toContain("I leap.");
  expect(messages[3]!.content).toStartWith("The Check is resolved");
});

test("the model and Model Instructions can change between Turns of a Save", async () => {
  play([narrated("Rain."), narrated("Wind.")]);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  await app.patch("/settings", { textModel: "fake/other", modelInstructions: "Write in present tense." });
  await app.post(`/saves/${id}/turns`, { input: "I wait more." });

  expect(provider.requests.map(({ body }) => body.model)).toEqual(["fake/model", "fake/other"]);
  expect(provider.requests[1]!.body.messages[0].content).toContain("Write in present tense.");
});

test("Settings survive a restart, and the API key never reaches a response, a Save or the log", async () => {
  play([httpError({ message: "Bad key test-key" }, 401)()]);
  const id = await app.createSave();
  let failed = "";
  const log = await logOf(async () => {
    failed = await app.post(`/saves/${id}/turns`, { input: "I wait." }).then((r) => r.text());
  });
  await app.restart();

  const settings = await app.get("/settings").then((r) => r.text());

  expect(JSON.parse(settings)).toMatchObject({
    textBaseUrl: provider.baseUrl,
    textModel: "fake/model",
    hasTextApiKey: true,
    modelInstructions: "",
  });
  expect(provider.requests[0]!.authorization).toBe("Bearer test-key");
  expect(log).toContain("Bad key [key]");
  const save = await Bun.file(join(folder.path, "Saves", `${id}.sqlite`)).text();
  for (const place of [failed, settings, log, save]) expect(place).not.toContain("test-key");
});

test("changing the base URL drops a stored key unless a new one comes with it", async () => {
  play([]);
  const change = (body: unknown) => app.patch("/settings", body).then((r) => r.json());

  expect(await change({ textBaseUrl: "http://localhost:1234/v1" })).toMatchObject({ hasTextApiKey: false });
  expect(await change({ textBaseUrl: "http://localhost:1235/v1", textApiKey: "new" })).toMatchObject({
    hasTextApiKey: true,
  });
  expect(await change({ textModel: "local" })).toMatchObject({ hasTextApiKey: true });
  expect((await app.patch("/settings", { textBaseUrl: "file:///etc/passwd" })).status).toBe(400);
});

test("a client that leaves mid-stream doesn't stop the Turn, which is saved", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      yield delta("rises.");
      await Bun.sleep(150);
      yield delta('"}');
      yield "data: [DONE]\n\n";
    },
  ]);
  const id = await app.createSave();
  const client = new AbortController();

  const response = await streamTurn(id, "I wade forward.", client.signal);
  await response.body!.getReader().read();
  client.abort();

  await Bun.sleep(300);
  expect((await storedMessages(id)).map(({ text }) => text)).toEqual(["I wade forward.", "The tide rises."]);
});

// 14s, so it runs only with SLOW_TESTS=1: it guards the `idleTimeout: 0` in rest-api.ts.
test.skipIf(!process.env.SLOW_TESTS)(
  "a streamed Turn survives a silence longer than Bun's default idle timeout",
  async () => {
    play([
      async function* () {
        await Bun.sleep(14_000);
        yield* narrated("The tide rises.");
      },
    ]);
    const id = await app.createSave();

    const events = await turnEvents(await streamTurn(id, "I wade forward."));

    expect(events.at(-1)!.event).toBe("done");
  },
  20_000,
);

test("every reply is sent with the token limit from Settings", async () => {
  play([narrated("Rain."), narrated("Sleet.")]);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  settingsStore(join(folder.path, "settings.json")).update({ textMaxTokens: 4000 });
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.map(({ body }) => body.max_tokens)).toEqual([16_000, 4000]);
});

test("OpenRouter is sent the Thinking level only once the player picks one, and only for a model that takes it", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["structured_outputs", "reasoning"] }] };
  play([narrated("Rain."), narrated("Sleet.")], thinking, scriptedDice(), true);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "low" });
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([undefined, { effort: "low" }]);
});

test("an OpenRouter model list that doesn't answer is asked again, so the Thinking level isn't lost until a restart", async () => {
  play([narrated("Rain."), narrated("Sleet.")], {}, scriptedDice(), true);
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "low" });
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  provider.setModels({ data: [{ id: "fake/model", supported_parameters: ["structured_outputs", "reasoning"] }] });
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([undefined, { effort: "low" }]);
});

test("NanoGPT is sent the Thinking level only for a model its detailed listing says thinks", async () => {
  const listing = {
    data: [
      { id: "fake/model", capabilities: { reasoning: true } },
      { id: "plain/model", capabilities: { reasoning: false } },
    ],
  };
  play([narrated("Rain."), narrated("Sleet.")], listing);
  settingsStore(join(folder.path, "settings.json")).update({
    textBaseUrl: provider.nanoGptUrl,
    textApiKey: "test-key",
    textModel: "fake/model",
    textThinking: "high",
  });
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  settingsStore(join(folder.path, "settings.json")).update({ textModel: "plain/model" });
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([{ effort: "high" }, undefined]);
});

test("Google is sent the Thinking level as reasoning_effort, only for a model its own API says thinks", async () => {
  play([narrated("Rain."), narrated("Sleet.")]);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textBaseUrl: provider.googleUrl, textApiKey: "test-key", textModel: "gemini-thinking", textThinking: "low" });
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  settings.update({ textModel: "gemma-plain" });
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.map(({ body }) => [body.reasoning_effort, body.reasoning])).toEqual([
    ["low", undefined],
    [undefined, undefined],
  ]);
});

test("a Thinking level a host refuses is dropped for that model, and the schema is kept", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["structured_outputs", "reasoning"] }] };
  const noHost = new Response(JSON.stringify({ error: { message: "No endpoints found" } }), { status: 404 });
  play([noHost, narrated("Rain."), narrated("Sleet.")], thinking, scriptedDice(), true);
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "low" });
  const id = await app.createSave();

  const log = await logOf(async () => {
    await app.post(`/saves/${id}/turns`, { input: "I wait." });
    await app.post(`/saves/${id}/turns`, { input: "I wait." });
  });

  expect(provider.requests.map(({ body }) => [!!body.reasoning, !!body.response_format])).toEqual([
    [true, true],
    [false, true],
    [false, true],
  ]);
  expect(log).toContain("Thinking level refused");
  expect(log).toContain('"thinkingSent":false');
});

test("the Settings test is sent the Thinking level too, though it has no schema", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["reasoning"] }] };
  play([[delta("Hello."), "data: [DONE]\n\n"]], thinking, scriptedDice(), true);
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "medium" });
  await textProvider(settingsStore(join(folder.path, "settings.json")))([{ role: "user", content: "Hi" }], {
    onText: () => {},
    signal: new AbortController().signal,
  });

  expect(provider.requests[0]!.body.reasoning).toEqual({ effort: "medium" });
});

test("a call asked for less thinking is sent a lower level, never below Low, and the model's own level as a step above Low", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["reasoning"] }] };
  const said = [delta("Hello."), "data: [DONE]\n\n"];
  play([said, said, said, said, said], thinking, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  const send = (lessThinking: number) =>
    textProvider(settings)([{ role: "user", content: "Hi" }], { lessThinking, onText: () => {}, signal: new AbortController().signal });
  settings.update({ textThinking: "high" });
  await send(1);
  await send(5);
  settings.update({ textThinking: "low" });
  await send(1);
  settings.update({ textThinking: "default" });
  await send(1);
  await send(2);

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([
    { effort: "medium" },
    { effort: "low" },
    { effort: "low" },
    { effort: "low" },
    { effort: "low" },
  ]);
});

test("a call with a thinking budget sends it to a model whose listing takes one, and the level to one that doesn't", async () => {
  const listing = {
    data: [
      { id: "fake/model", supported_parameters: ["reasoning"], reasoning: { supports_max_tokens: true } },
      { id: "plain/model", supported_parameters: ["reasoning"] },
    ],
  };
  const said = [delta("Hello."), "data: [DONE]\n\n"];
  play([said, said, said], listing, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textThinking: "low" });
  const send = (thinkingBudget?: number) =>
    textProvider(settings)([{ role: "user", content: "Hi" }], { thinkingBudget, onText: () => {}, signal: new AbortController().signal });

  const log = await logOf(async () => {
    await send(1000);
    await send();
    settings.update({ textModel: "plain/model" });
    await send(1000);
  }, "info");

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([{ max_tokens: 1000 }, { effort: "low" }, { effort: "low" }]);
  expect(log).toContain('"thinkingBudget":1000');
});

test("a model that can't take a thinking budget is stopped by time alone, from its first thinking token, and one that can is left to the provider", async () => {
  const listing = {
    data: [
      { id: "fake/model", supported_parameters: ["reasoning"], reasoning: { supports_max_tokens: true } },
      { id: "plain/model", supported_parameters: ["reasoning"] },
    ],
  };
  const hmm = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Hmm, let me think again. " } }] })}\n\n`;
  // Far past the budget's length, quickly, after a wait before the first thinking token that isn't counted.
  const long = async function* () {
    await Bun.sleep(150);
    for (let at = 0; at < 40; at++) yield hmm;
    yield* [delta("Done."), "data: [DONE]\n\n"];
  };
  const slow = async function* () {
    yield hmm;
    await Bun.sleep(150);
    yield hmm;
    yield* [delta("Done."), "data: [DONE]\n\n"];
  };
  play([long, slow, slow], listing, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textThinking: "low", textModel: "plain/model" });
  const send = () =>
    textProvider(settings)([{ role: "user", content: "Hi" }], { thinkingBudget: 100, thinkingMs: 100, onText: () => {}, signal: new AbortController().signal });

  const log = await logOf(async () => {
    expect(await send()).toBe("Done.");
    await expect(send()).rejects.toBeInstanceOf(ThinkingBudgetReached);
    settings.update({ textModel: "fake/model" });
    expect(await send()).toBe("Done.");
  }, "info");

  expect(log).toContain("Thinking budget reached");
  expect(log).toContain('"budget":100');
});

test("a reply cut by its caller's time limit is logged as a time limit, not as the client leaving", async () => {
  play([
    async function* () {
      await Bun.sleep(200);
      yield* narrated("Late.");
    },
  ]);
  const log = await logOf(async () => {
    await textProvider(settingsStore(join(folder.path, "settings.json")))([{ role: "user", content: "Hi" }], {
      onText: () => {},
      signal: AbortSignal.timeout(20),
    }).catch(() => {});
  }, "info");

  expect(log).toContain('"failed":"time limit"');
});

test("a model that refuses Low is sent the next level up instead, and isn't sent Low again", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["reasoning"] }] };
  const said = [delta("Hello."), "data: [DONE]\n\n"];
  const refused = new Response(JSON.stringify({ error: { message: "Reasoning is mandatory" } }), { status: 400 });
  play([refused, said, said, said], thinking, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textThinking: "medium" });
  const provide = textProvider(settings);
  const send = (lessThinking: number) => provide([{ role: "user", content: "Hi" }], { lessThinking, onText: () => {}, signal: new AbortController().signal });
  const log = await logOf(async () => {
    await send(1);
    await send(1);
    await send(0);
  });

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([{ effort: "low" }, { effort: "medium" }, { effort: "medium" }, { effort: "medium" }]);
  expect(log).toContain("Thinking level raised");
});

test("a hurried call is sent thinking off, and a model that refuses it is sent its level then and never asked for none again", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["reasoning"] }] };
  const said = [delta("Hello."), "data: [DONE]\n\n"];
  const refused = new Response(JSON.stringify({ error: { message: "Reasoning is mandatory" } }), { status: 400 });
  play([said, refused, said, said], thinking, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textThinking: "low" });
  const send = (provide: TextProvider) =>
    provide([{ role: "user", content: "Hi" }], { thinkingOff: true, onText: () => {}, signal: new AbortController().signal });
  await send(textProvider(settings));
  // A new provider, as one that took it would send it again.
  const refusing = textProvider(settings);
  const log = await logOf(async () => {
    await send(refusing);
    await send(refusing);
  });

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([{ enabled: false }, { enabled: false }, { effort: "low" }, { effort: "low" }]);
  expect(log).toContain("Thinking off refused");
});

test("a call asked to think not at all, of a model that refuses that, isn't stopped by the thinking budget, as it is the last try", async () => {
  const thinking = { data: [{ id: "fake/model", supported_parameters: ["reasoning"] }] };
  const hmm = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Hmm. " } }] })}\n\n`;
  const slow = async function* () {
    yield hmm;
    await Bun.sleep(150);
    yield hmm;
    yield* [delta("Done."), "data: [DONE]\n\n"];
  };
  const refused = new Response(JSON.stringify({ error: { message: "Reasoning is mandatory" } }), { status: 400 });
  play([refused, slow, slow], thinking, scriptedDice(), true);
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ textThinking: "low" });
  const provide = textProvider(settings);
  const send = () =>
    provide([{ role: "user", content: "Hi" }], {
      thinkingOff: true,
      thinkingBudget: 100,
      thinkingMs: 50,
      onText: () => {},
      signal: new AbortController().signal,
    });

  const log = await logOf(async () => {
    expect(await send()).toBe("Done.");
    // Remembered, so the next is sent its level at once, and isn't stopped either.
    expect(await send()).toBe("Done.");
  }, "info");

  expect(provider.requests.map(({ body }) => body.reasoning)).toEqual([{ enabled: false }, { effort: "low" }, { effort: "low" }]);
  expect(log).toContain("Thinking budget waived");
});

test("a reply silent from its first byte is asked for once more, as a stuck request mostly isn't stuck twice", async () => {
  const silent = async function* () {
    await new Promise(() => {});
  };
  play([silent, [delta("Hello."), "data: [DONE]\n\n"]]);
  const provide = textProvider(settingsStore(join(folder.path, "settings.json")), { silenceMs: 100, listMs: 1000 });

  const log = await logOf(async () => {
    expect(await provide([{ role: "user", content: "Hi" }], { call: "turn", onText: () => {}, signal: new AbortController().signal })).toBe("Hello.");
  });

  expect(provider.requests).toHaveLength(2);
  // Named by the silent call's id, so the line pairs with that call's prompt.
  const silentId = log.match(/Prompt sent \{"call":"turn","id":"([^"]+)"/)?.[1];
  expect(log).toContain(`Silent reply asked again {"call":"turn","id":"${silentId}","model":"fake/model","ms":`);
  // Each reply's line names what the call was for, so the bench can count its tokens by it.
  expect(log).toMatch(/Text reply \{"call":"turn","id":"[0-9a-z]+-\d+","model":"fake\/model"/);
});

test("a call's prompt and reply lines share one id, so calls running at once can be paired in the log", async () => {
  play([
    [delta("One."), "data: [DONE]\n\n"],
    [delta("Two."), "data: [DONE]\n\n"],
  ]);
  const provide = textProvider(settingsStore(join(folder.path, "settings.json")));
  const ask = (call: string) => provide([{ role: "user", content: "Hi" }], { call, onText: () => {}, signal: new AbortController().signal });

  const log = await logOf(() => Promise.all([ask("turn"), ask("upkeep")]), "verbose");

  for (const call of ["turn", "upkeep"]) {
    const sent = log.match(new RegExp(`Prompt sent \\{"call":"${call}","id":"([^"]+)"`))?.[1];
    expect(sent).toBeDefined();
    expect(log).toContain(`Text reply {"call":"${call}","id":"${sent}",`);
  }
});

test("a reply that stalls after some text is not asked again", async () => {
  const stalls = async function* () {
    yield delta("Hel");
    await new Promise(() => {});
  };
  play([stalls, [delta("Hello."), "data: [DONE]\n\n"]]);
  const provide = textProvider(settingsStore(join(folder.path, "settings.json")), { silenceMs: 100, listMs: 1000 });

  expect(provide([{ role: "user", content: "Hi" }], { onText: () => {}, signal: new AbortController().signal })).rejects.toThrow("stopped responding");
  await Bun.sleep(300);
  expect(provider.requests).toHaveLength(1);
});

test("a local server is never sent reasoning, even with a level kept from another provider", async () => {
  play([narrated("Rain.")], { data: [{ id: "fake/model", capabilities: { reasoning: true } }] });
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "high" });
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.at(-1)!.body.reasoning).toBeUndefined();
});

test("a model whose listing doesn't take reasoning is never sent it", async () => {
  play([narrated("Rain.")], schemaModel, scriptedDice(), true);
  settingsStore(join(folder.path, "settings.json")).update({ textThinking: "low" });
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(provider.requests.at(-1)!.body.reasoning).toBeUndefined();
});

test("a model stuck thinking is stopped at the thinking limit and asked again", async () => {
  const thinking = async function* () {
    for (let at = 0; at < 1000; at++) yield `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Hmm, let me think again. " } }] })}\n\n`;
  };
  play([thinking, narrated("The tide rises.")]);
  settingsStore(join(folder.path, "settings.json")).update({ textThinkingTokens: 1000 });
  const id = await app.createSave();

  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201));

  expect(provider.requests).toHaveLength(2);
  expect(log).toContain("thought far too long");
  expect((await storedMessages(id)).at(-1)).toMatchObject({ text: "The tide rises." });
});

const cutOff = [
  delta('{"check":null,"narration":"On and on'),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}

`,
];

test('a speaker tag written as [Name: ""] is saved as [Name]:, and shows as one', async () => {
  play([narrated('She sits.\n\n[Lena: ""] "I want to see it."\n\n[Mara:] "Fine."')]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).at(-1)!.text).toBe('She sits.\n\n[Lena]: "I want to see it."\n\n[Mara]: "Fine."');
  expect(messageBeats({ role: "narrator", text: '[Lena: ""] "Here."' })).toEqual([{ speaker: "Lena", text: '"Here."' }]);
  expect(messageBeats({ role: "narrator", text: "[Note:] The door is shut." })).toEqual([{ text: "[Note:] The door is shut." }]);
});

test("a speaker tag with no colon before its quote is saved as [Name]:, and shows as one", async () => {
  play([narrated('She sits.\n\n[Tamsin] "Get the skins checked."\n\n[Voice, breathless] “Riders!”')]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).at(-1)!.text).toBe('She sits.\n\n[Tamsin]: "Get the skins checked."\n\n[Voice, breathless]: “Riders!”');
  // Messages saved before show as speech too.
  expect(messageBeats({ role: "narrator", text: '[Tamsin] "Here."' })).toEqual([{ speaker: "Tamsin", text: '"Here."' }]);
  // Brackets before prose, with no quote, are no tag.
  expect(messageBeats({ role: "narrator", text: "[Later] The door is shut." })).toEqual([{ text: "[Later] The door is shut." }]);
});

test("a literal backslash-n in a reply is a paragraph break, not text the player reads", () => {
  expect(messageBeats({ role: "narrator", text: '[Dacre]: "A telegraph came.\\n\\nHe let that stand.' })).toEqual([
    { speaker: "Dacre", text: '"A telegraph came.' },
    { text: "He let that stand." },
  ]);
});

test("a speaker written without brackets is saved as [Name]:, so later replies copy that", async () => {
  play([narrated('She sits.\n\nNadia: "I saw him."\n\nSign: “Closed”\n\nThen: nothing.')]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).at(-1)!.text).toBe('She sits.\n\n[Nadia]: "I saw him."\n\n[Sign]: “Closed”\n\nThen: nothing.');
});

test("a reply that gives the PC a spoken line is written again", async () => {
  play([narrated('He looks up.\n\nAsh: "Look at me."'), narrated('He looks up.\n\n[Owen]: "Well?"')]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect(provider.requests).toHaveLength(2);
  expect((await storedMessages(id)).at(-1)!.text).toBe('He looks up.\n\n[Owen]: "Well?"');
});

const meeting = (...names: string[]) => [
  delta(JSON.stringify({ check: null, narration: "Someone.", state_operations: [], people: names.map((name) => ({ name, appearance: "tall" })) })),
  "data: [DONE]\n\n",
];
const knownPeople = async (id: string) => ((await app.get(`/saves/${id}/journal`).then((r) => r.json())) as { npcs: string[] }).npcs;

test("someone new given a first name the PC or someone in the story has is written again, kept on the last attempt", async () => {
  play([
    meeting("Ash Tate"),
    meeting("Mara Kade"),
    meeting("Owen Kade", "Man in grey coat"),
    meeting("Man in red coat", "Mrs. Owen"),
    meeting("Mrs. Owen"),
    meeting("Mrs. Owen"),
  ]);
  const id = await app.createSave();

  for (const input of ["I look.", "I look.", "I look."]) expect((await app.post(`/saves/${id}/turns`, { input })).status).toBe(201);

  expect(provider.requests).toHaveLength(6);
  expect(await knownPeople(id)).toEqual(["Mara Kade", "Owen Kade", "Man in grey coat", "Mrs. Owen"]);
});

test("a spaced speaker tag, an empty one and a line of prose in brackets are tidied", () => {
  expect(
    messageBeats({ role: "narrator", text: '[ Tamsin ]: "Here."\n[Bette]:\nShe turns.\n[He shut the door on the wind]\n[Old Man]\n[Jan van Dijk]' }),
  ).toEqual([
    { speaker: "Tamsin", text: '"Here."' },
    { text: "She turns." },
    { text: "He shut the door on the wind" },
    { text: "[Old Man]" },
    { text: "[Jan van Dijk]" },
  ]);
  expect(messageBeats({ role: "narrator", text: '[Mara]:\n\n"Get down!"' })).toEqual([{ speaker: "Mara", text: '"Get down!"' }]);
});

test("a reply that leaves one of its fields in the narration is saved without it, and all after it", async () => {
  play([narrated("He sits.\n\nstate_operations:[]\nsummary: He sat.")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect(provider.requests).toHaveLength(1);
  expect((await storedMessages(id)).at(-1)!.text).toBe("He sits.");
});

test("a reply whose narration ends on a line about one of its fields, with no colon, is saved without it", async () => {
  play([narrated("He sits.\n\nstate_operations has more ops")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).at(-1)!.text).toBe("He sits.");
});

test("a reply that ends on a speaker tag with no words is saved without it", async () => {
  play([narrated("She keeps the boy by her.\n\n[Lieutenant Rennie]:")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).at(-1)!.text).toBe("She keeps the boy by her.");
});

test("a reply that ends its narration with the brace or tag of its own JSON is saved without them", async () => {
  play([narrated('[Ilse]: "Since dawn?"}</arg_value>'), narrated("He sits.}")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);
  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect((await storedMessages(id)).map(({ text }) => text).slice(-3)).toEqual(['[Ilse]: "Since dawn?"', "I wait.", "He sits."]);
});

test("a reply that repeats an operation on one record is kept with only the first, not written again", async () => {
  const update = (now: string) => ({ op: "update_plot_thread", thread: "The duke plots.", now, truth: null });
  const learns = { op: "add_known_fact", fact: "The duke keeps a ledger." };
  play([narrated("He sits.", update("The duke waits."), learns, update("The duke strikes."), learns)]);
  // With the thread there, as a rewrite that matches none is ignored rather than added.
  const store = saveStore(join(folder.path, "Saves"));
  const id = store.create({ worldBrief: "A drowned city", pc: { name: "Ash" }, opening: { plotThreads: ["The duke plots."] } });

  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201));

  expect(provider.requests).toHaveLength(1);
  expect(store.latestState(id).threadsNow).toEqual({ "The duke plots.": "The duke waits." });
  expect(log).toContain('"sent":4,"kept":2');
});

test("a reply that runs on in its operations is kept up to its last whole one, as its narration came whole, and its lost picture logged", async () => {
  const runOn = async function* () {
    yield delta(
      '{"check":null,"narration":"He sits.","people":[],"state_operations":[{"op":"set_scene","location":"The quay","visible_cast":[]},{"op":"add_known_fact","fact":"The duke keeps a ledger."}',
    );
    for (let at = 0; at < 1000; at++) yield delta(',{"op":"update_plot_thread","thread":"The duke plots.","now":"The duke plots.","truth":null}');
  };
  play([runOn]);
  const store = saveStore(join(folder.path, "Saves"));
  const id = store.create({ worldBrief: "A drowned city", pc: { name: "Ash" }, opening: { plotThreads: ["The duke plots."] } });

  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201), "info");

  expect(provider.requests).toHaveLength(1);
  expect((await storedMessages(id)).at(-1)!.text).toBe("He sits.");
  expect(store.latestState(id).pcKnown.facts).toEqual(["The duke keeps a ledger."]);
  expect(log).toContain("Run-on reply kept");
  // The picture's prompt came after the operations, so it never came.
  expect(log).toContain('"message":2,"words":0');
});

test("Choices lose JSON marks left at their end, and one-word Choices told apart by a number are one", () => {
  expect(usableChoices(["I go north.:null,", 'I say, "Wait."', "I wait here]]}​"])).toEqual(["I go north.", 'I say, "Wait."', "I wait here"]);
  expect(usableChoices(["next", "next2", "next3"])).toBeUndefined();
  expect(usableChoices(["我打开门", "我逃跑", "我问她"])).toEqual(["我打开门", "我逃跑", "我问她"]);
  expect(withoutJsonTail('A lane at dusk"],')).toBe("A lane at dusk");
  expect(withoutJsonTail('I shout "Run!""]')).toBe('I shout "Run!"');
  // A picture's likeness sentence ends the field, so its brace stays when it closes one the text opened.
  expect(withoutJsonTail("A lane. {The same people.}")).toBe("A lane. {The same people.}");
  expect(withoutJsonTail("A lane. {The same people.}}")).toBe("A lane. {The same people.}");
  expect(withoutJsonTail("A lane.}")).toBe("A lane.");
});

test("a line refused as the PC's is refused again when a retry gives it, nearly word for word, to someone else", async () => {
  const pcLine = "Ash leans in.\n\n[Ash]: “I'll not say a word to the sexton, nor name you to any soul. But listen to me now.”\n\nThe lad nods slowly.";
  const relabelled = pcLine.replace("[Ash]", "[Kit Rowan]").replace("listen to me now", "listen to me");
  play([narrated(pcLine), narrated(relabelled), narrated("Ash leans in, and the lad nods slowly, his cap turning in his hands.")]);
  const id = await app.createSave();

  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201), "info");

  expect(provider.requests).toHaveLength(3);
  expect((await storedMessages(id)).at(-1)!.text).toStartWith("Ash leans in, and the lad");
  expect(log).toContain("Refused line given to another");
});

test("a Turn is rated once: a retry after a reply rated None is asked for no Check and rolls none", async () => {
  const none = { action: "Wait", stakes: "nothing", difficulty: "None" };
  play(
    [
      [
        delta(JSON.stringify({ check: none, narration: 'Ash leans in.\n\n[Ash]: "Tell me who keeps the gate tonight."', state_operations: [] })),
        "data: [DONE]\n\n",
      ],
      [delta(CHECK_REPLY)],
      narrated("The keeper says nothing."),
    ],
    schemaModel,
  );
  const id = await app.createSave();

  // The dice are empty, so a roll would fail the Turn.
  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201), "info");

  expect(provider.requests).toHaveLength(3);
  expect(provider.requests[1]!.body.response_format.json_schema.schema.properties.check).toMatchObject({ type: "null" });
  expect((await storedMessages(id)).at(-1)!.text).toBe("The keeper says nothing.");
  expect(log).toContain("Rating kept for a retry");
});

test("a PC line that only repeats the move's own quoted words isn't speaking for the PC, but one with other words is", () => {
  const move = 'I lean in. "Who keeps the gate tonight?"';
  expect(spokenLineFault("[Ash]: “who keeps the gate tonight”\n\nThe lad shrugs.", "Ash", move)).toBeUndefined();
  expect(spokenLineFault('[Ash]: "Who keeps the gate tonight? Tell me."', "Ash", move)).toBe("a spoken line for the PC");
  expect(spokenLineFault('[Ash]: "Who keeps the gate tonight?"', "Ash")).toBe("a spoken line for the PC");
});

test("a reply whose PC line is the player's own quote is kept, and logged", async () => {
  play([narrated('Ash leans in.\n\n[Ash]: "Who keeps the gate tonight?"\n\nThe lad shrugs.')]);
  const id = await app.createSave();

  const log = await logOf(async () => expect((await app.post(`/saves/${id}/turns`, { input: '"Who keeps the gate tonight?"' })).status).toBe(201), "info");

  expect(provider.requests).toHaveLength(1);
  expect(log).toContain("PC line passed as the move's own words");
});

test("a line for someone who only shares the PC's title isn't the PC's", () => {
  expect(spokenLineFault('[Captain]: "Hold."', "Captain Elena Reyes")).toBeUndefined();
  expect(spokenLineFault('[Elena]: "Hold."', "Captain Elena Reyes")).toBe("a spoken line for the PC");
});

test("a given name is the first word after any article or title, and only clashes then", () => {
  const state = (...names: string[]) =>
    ({ npcs: names.map((name) => ({ name, appearance: "tall" })), pcKnown: { npcs: [] }, inventory: { wearing: [], carrying: [] } }) as never;
  const adds = (...names: string[]) => names.map((name) => ({ op: "add_npc" as const, name, appearance: "tall" }));
  const refused = (names: string[], operations: Parameters<typeof introduce>[3]) => introduce(state(...names), [], "Ash", operations).refused.length;

  expect(refused(["The Bartender", "Old Man"], adds("The Guard", "Young Man", "Man in grey coat"))).toBe(0);
  expect(refused(["Sarah"], [...adds("Sarah Connor"), { op: "merge_npc", name: "Sarah", into: "Sarah Connor" }])).toBe(0);
  expect(refused([], adds("Tom Hardy", "Tom Jones"))).toBe(1);
  expect(refused([], adds("Dr. Ash Vale"))).toBe(1);
});

test("someone a reply names by part of their name is the person already in the story", async () => {
  play([meeting("Owen Kade"), meeting("Owen")]);
  const id = await app.createSave();

  for (const input of ["I look.", "I wait."]) expect((await app.post(`/saves/${id}/turns`, { input })).status).toBe(201);

  expect(provider.requests).toHaveLength(2);
  expect(await knownPeople(id)).toEqual(["Owen Kade"]);
});

test("someone a reply names without their title is the person already in the story", async () => {
  play([meeting("Reverend Owen Kade"), meeting("Owen Kade")]);
  const id = await app.createSave();

  for (const input of ["I look.", "I wait."]) expect((await app.post(`/saves/${id}/turns`, { input })).status).toBe(201);

  expect(provider.requests).toHaveLength(2);
  expect(await knownPeople(id)).toEqual(["Reverend Owen Kade"]);
});

test("a reply whose narration is a JSON object, such as its Check request, is written again", async () => {
  const request = JSON.stringify({ action: "Ask him what he knows", stakes: "He could walk away", difficulty: "Moderate" });
  play([narrated(request), narrated("He shrugs.")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I ask." })).status).toBe(201);

  expect(provider.requests).toHaveLength(2);
  expect((await storedMessages(id)).at(-1)!.text).toBe("He shrugs.");
});

test("a reply that marks its paragraphs as Markdown quotes is saved without the marks, and shows without them", async () => {
  play([narrated('>The tide rises.\n\n> [Nadia]: "Run."')]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  const text = (await storedMessages(id)).at(-1)!.text;
  expect(text).toBe('The tide rises.\n\n[Nadia]: "Run."');
  expect(messageBeats({ role: "narrator", text: '>The tide rises.\n>Nadia: "Run."' })).toEqual([
    { text: "The tide rises." },
    { speaker: "Nadia", text: '"Run."' },
  ]);
});

test("a reply cut off at the token limit is written again, as a model stuck in a loop mostly isn't the next time", async () => {
  play([cutOff, narrated("The tide rises.")]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);

  expect(provider.requests).toHaveLength(2);
  expect((await storedMessages(id)).at(-1)).toMatchObject({ text: "The tide rises." });
});

test("a reply that runs on far past any real one is stopped early and written again, and three fail the Turn", async () => {
  // Never finishing, so only the length of what it has sent can stop it.
  const loop = async function* () {
    yield delta('{"check":null,"narration":"');
    for (let at = 0; at < 1000; at++) yield delta("and on and on and on and on and on and on and on and on. ");
  };
  play([loop, loop, loop]);
  const id = await app.createSave();

  let status = 0;
  const log = await logOf(async () => {
    status = (await app.post(`/saves/${id}/turns`, { input: "I wait." })).status;
  });

  expect(status).toBe(502);
  expect(provider.requests).toHaveLength(3);
  expect(await storedMessages(id)).toEqual([]);
  // Logged as a runaway, not as the Check request it once was mistaken for.
  expect(log).toContain('"reason":"ran on far too long"');
});

test("thinking a model streams in its reply doesn't count toward a runaway", async () => {
  const thinker = async function* () {
    yield delta("<think>");
    for (let at = 0; at < 600; at++) yield delta("Let me weigh where the scene goes from here. ");
    yield delta("</think>");
    yield* narrated("The tide rises.");
  };
  play([thinker]);
  const id = await app.createSave();

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait." })).status).toBe(201);
  expect(provider.requests).toHaveLength(1);
});

test("outside a Turn, a reply cut off at the token limit fails at once and says why, as another try would run as long", async () => {
  play([cutOff, cutOff, cutOff]);
  const id = await app.createSave();

  const failed = await app.post(`/saves/${id}/world-change`, { change: "the mayor smuggles" });

  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("ran far too long");
  expect(provider.requests).toHaveLength(1);
});

test("a reply that streams past the time limit in Settings is stopped, and nothing is saved", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"');
      // Never silent, so only the time limit can stop it.
      for (let at = 0; at < 100; at++) {
        await Bun.sleep(50);
        yield delta("and ");
      }
    },
  ]);
  settingsStore(join(folder.path, "settings.json")).update({ textReplyMinutes: 0.005 });
  const id = await app.createSave();

  const started = Date.now();
  const failed = await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect(Date.now() - started).toBeLessThan(3000);
  expect(await failed.text()).toContain("ran far too long");
  expect(provider.requests).toHaveLength(1);
  expect(await storedMessages(id)).toEqual([]);
});

const textTest = (prompt: string) => app.post("/settings/text-test", { prompt });
const body = (response: Response) => response.json() as Promise<Record<string, any>>;

test("with no Model Instructions the Settings text test sends just the prompt, and returns the reply with how it went", async () => {
  play([[delta("Hello "), delta("there."), "data: [DONE]\n\n"]], schemaModel);

  const response = await textTest("Say hello");

  expect(response.status).toBe(200);
  const { seconds, firstSeconds, ...rest } = await body(response);
  expect(rest).toEqual({ reply: "Hello there.", tokens: 3, model: "fake/model" });
  expect(firstSeconds).toBeGreaterThanOrEqual(0);
  expect(seconds).toBeGreaterThanOrEqual(firstSeconds);
  const sent = provider.requests[0]!.body;
  expect(sent.messages).toEqual([{ role: "user", content: "Say hello" }]);
  expect(sent.response_format).toBeUndefined();
  expect(sent.provider).toBeUndefined();
});

test("the Settings text test sends the Model Instructions as the system prompt", async () => {
  play([[delta("Aye."), "data: [DONE]\n\n"]]);
  await app.patch("/settings", { modelInstructions: "Answer like a sailor." });

  await textTest("Say hello");

  expect(provider.requests[0]!.body.messages).toEqual([
    { role: "system", content: "Answer like a sailor." },
    { role: "user", content: "Say hello" },
  ]);
});

test("the Settings text test refuses an empty prompt without calling the model", async () => {
  play([]);

  expect((await textTest("   ")).status).toBe(400);
  expect(provider.requests).toHaveLength(0);
});

test("the Settings text test says when the model refused", async () => {
  play([[`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\n`]]);

  const response = await textTest("Say hello");

  expect(response.status).toBe(422);
  expect((await body(response)).error).toBe("The model refused this prompt.");
});

test("the Settings text test says when the server can't be reached", async () => {
  play([]);
  provider.stop();

  const response = await textTest("Say hello");

  expect(response.status).toBe(502);
  expect((await body(response)).error).toContain("can't be reached");
});

const broken = ['data: {"choices":[{"delta":{"content":"The ti\n\n'];

test("a broken line in the stream retries the Turn, and the log shows why", async () => {
  play([broken, narrated("The tide rises.")]);
  const id = await app.createSave();

  const log = await logOf(async () => {
    const events = await turnEvents(await streamTurn(id, "I wade forward."));
    expect(events.at(-1)!.event).toBe("done");
  });

  expect(provider.requests).toHaveLength(2);
  expect((await storedMessages(id)).at(-1)!.text).toBe("The tide rises.");
  expect(log).toContain('"attempt":1,"of":3');
  expect(log).toContain('"last":{"chars":');
  expect(log).not.toContain("The ti");
});

test("a stream that stays broken fails the Turn as retryable once the retries run out", async () => {
  play([broken, broken, broken]);
  const id = await app.createSave();

  await logOf(async () => {
    const events = await turnEvents(await streamTurn(id, "I wade forward."));
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { status: 502, error: "The Narrator gave no usable response", failure: "retryable", input: "I wade forward." },
    });
  });

  expect(provider.requests).toHaveLength(3);
  expect(await storedMessages(id)).toEqual([]);
});

test("the log shows how each reply went, and none of the story", async () => {
  const finished = sse({
    id: "gen-1",
    provider: "FakeHost",
    choices: [{ delta: { content: "" }, finish_reason: "stop", native_finish_reason: "STOP" }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  const reply = { check: null, narration: "The tide rises.", state_operations: [], people: [{ name: "Ada", appearance: "tall" }], summary: "A wet day." };
  play([[delta(JSON.stringify(reply)), finished, "data: [DONE]\n\n"]]);
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "I wade forward.").then(turnEvents));

  for (const fact of ['"generation":"gen-1"', '"provider":"FakeHost"', '"finish":"stop"', '"nativeFinish":"STOP"', '"completion_tokens":7']) {
    expect(log).toContain(fact);
  }
  expect(log).toContain('"people":1');
  expect(log).toContain('"summary":10');
  expect(log).toContain('"attempts":1');
  for (const story of ["The tide rises", "A wet day", "I wade forward", "Ada"]) expect(log).not.toContain(story);
});

test("with Story in log on, each prompt and reply goes to the log whatever the Log Level, but never the key", async () => {
  play([narrated("The tide rises over test-key.")]);
  await app.patch("/settings", { storyInLog: true, logLevel: "error" });
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "I wade forward.").then(turnEvents));
  // The Log Level is the whole process's, so the tests after this one get theirs back.
  await app.patch("/settings", { logLevel: null });

  expect(log).toContain("The tide rises over [key].");
  expect(log).toContain("I wade forward.");
  expect(log).not.toContain("test-key");
});

test("a client that leaves is logged as that, not as a failed Turn", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      await Bun.sleep(100);
      yield delta('rises."}');
    },
  ]);
  const id = await app.createSave();
  const client = new AbortController();

  const log = await logOf(async () => {
    const response = await streamTurn(id, "I wade forward.", client.signal);
    await response.body!.getReader().read();
    client.abort();
    await Bun.sleep(300);
  });

  expect(log).toContain("A Turn lost its client");
  expect(log).toContain("A Turn ended after its client left");
  expect(log.indexOf("lost its client")).toBeLessThan(log.indexOf("ended after its client left"));
  expect(log).not.toContain("A Turn failed");
  expect(log).not.toContain("I wade forward");
});

const liveTurn = (id: string) => app.get(`/saves/${id}/turn`).then((r) => r.json());

test("a running Turn can be read back with its text so far, and is gone once saved", async () => {
  const { promise: release, resolve: finish } = Promise.withResolvers<void>();
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      yield delta("rises.");
      await release;
      yield delta('"}');
    },
  ]);
  const id = await app.createSave();
  const client = new AbortController();
  const response = await streamTurn(id, "I wade forward.", client.signal);
  await response.body!.getReader().read();
  client.abort();
  await Bun.sleep(50);

  expect(await liveTurn(id)).toEqual({ running: { input: "I wade forward.", narration: "The tide rises.", after: 0 } });

  finish();
  await Bun.sleep(100);
  expect(await liveTurn(id)).toEqual({});
});

test("a replacement that is running names the Message it replaces", async () => {
  const { promise: release, resolve: finish } = Promise.withResolvers<void>();
  play([
    narrated("The tide rises."),
    async function* () {
      await release;
      yield* narrated("The tide falls.");
    },
  ]);
  const id = await app.createSave();
  await streamTurn(id, "I wade forward.").then(turnEvents);

  const replacing = app.post(`/saves/${id}/messages/2/regenerate`, {});
  await Bun.sleep(50);

  expect(await liveTurn(id)).toEqual({ running: { input: "", narration: "", after: 2, replaces: 2 } });
  finish();
  await replacing;
});

test("a Turn that fails with nobody there waits, once, for the player's return", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The ti');
      await Bun.sleep(50);
      throw new Error("The stream broke");
    },
  ]);
  const id = await app.createSave();
  const client = new AbortController();

  await logOf(async () => {
    const response = await streamTurn(id, "I wade forward.", client.signal);
    await response.body!.getReader().read();
    client.abort();
    await Bun.sleep(150);
  });

  expect(await liveTurn(id)).toMatchObject({ failed: { status: 502, input: "I wade forward.", error: expect.any(String) } });
  expect(await liveTurn(id)).toEqual({});
  expect(await storedMessages(id)).toEqual([]);
});

test("a second Turn while one runs is refused, and never reaches the model", async () => {
  const { promise: release, resolve: finish } = Promise.withResolvers<void>();
  play([
    async function* () {
      await release;
      yield* narrated("The tide rises.");
    },
    narrated("Never asked for."),
  ]);
  const id = await app.createSave();
  const first = streamTurn(id, "I wade forward.").then(turnEvents);
  await Bun.sleep(50);

  const second = await app.post(`/saves/${id}/turns`, { input: "I run." });

  expect(second.status).toBe(409);
  expect(provider.requests).toHaveLength(1);
  finish();
  expect((await first).at(-1)!.event).toBe("done");
});

test("a second Turn is allowed once the first has finished", async () => {
  play([narrated("One."), narrated("Two.")]);
  const id = await app.createSave();

  await streamTurn(id, "First.").then(turnEvents);
  const events = await streamTurn(id, "Second.").then(turnEvents);

  expect(events.at(-1)!.event).toBe("done");
});

test("a client that cancels its stream doesn't fail the Turn, which is saved", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The tide ');
      await Bun.sleep(100);
      yield delta("rises.");
      await Bun.sleep(100);
      yield delta('"}');
    },
  ]);
  const id = await app.createSave();

  const log = await logOf(async () => {
    const reader = (await streamTurn(id, "I wade forward.")).body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(400);
  });

  expect((await storedMessages(id)).at(-1)?.text).toBe("The tide rises.");
  expect(log).not.toContain("A Turn failed");
});

test("an Opening that fails with nobody there hands back no input", async () => {
  play([
    async function* () {
      yield delta('{"check":null,"narration":"The ti');
      await Bun.sleep(50);
      throw new Error("The stream broke");
    },
  ]);
  const id = await app.createSave();
  const client = new AbortController();

  await logOf(async () => {
    const response = await fetch(app.url(`/saves/${id}/opening`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: "{}",
      signal: client.signal,
    });
    await response.body!.getReader().read();
    client.abort();
    await Bun.sleep(150);
  });

  expect(await liveTurn(id)).toMatchObject({ failed: { input: "" } });
});

test("a reply that isn't JSON leaves none of its words in the log", async () => {
  const prose = [delta("Marcus waits by the door."), "data: [DONE]\n\n"];
  play([prose, prose, prose]);
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "I wade forward.").then(turnEvents));

  expect(log).toContain('"attempt":3,"of":3');
  expect(log).not.toContain("Marcus");
});

test("a provider's error is cut short in the log, as it may echo the story", async () => {
  play([httpError({ message: "x".repeat(1000) }, 500)()]);
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "I wade forward.").then(turnEvents));

  expect(log).toContain("x".repeat(100));
  expect(log).not.toContain("x".repeat(400));
});

test("a provider's error that repeats the prompt is held back from the log", async () => {
  play([httpError({ message: "You sent: ZQX-the-words-of-the-player" }, 500)()]);
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "ZQX-the-words-of-the-player").then(turnEvents));

  expect(log).toContain("it repeats the prompt");
  expect(log).not.toContain("ZQX");
});

test("speech left in the prose is found, but never a speaker line, an apostrophe or a quoted word", () => {
  expect(speechOutsideLines("'Guard take your iron, I heard,' she said.")).toBe(true);
  expect(speechOutsideLines("He said, “Go now.” Then he left.")).toBe(true);
  expect(speechOutsideLines("[Tamsin]: 'Thirty years.'")).toBe(false);
  expect(speechOutsideLines("Wren's satchel was heavy. The camels' hooves rang.")).toBe(false);
  expect(speechOutsideLines("She called it 'the old road' once.")).toBe(false);
});

test("placeholder operations, a known fact that is only a name, and a reply's resolves of more than one thread are dropped", () => {
  const kept = [
    { op: "add_item", slot: "carrying", item: "a brass key" },
    { op: "add_known_fact", fact: "Grout moved the tomb aside." },
  ];
  const junk = [
    { op: "resolve_plot_thread", thread: "x" },
    { op: "remove_lore_entry", title: "__none__" },
    { op: "remove_lore_entry", title: "nonexistent" },
    { op: "remove_lore_entry", title: "unused" },
    { op: "remove_lore_entry", title: " " },
    { op: "add_item", slot: "carrying", item: "x" },
    { op: "add_known_fact", fact: "Silas Grout" },
  ];
  expect(usableOperations([...kept, ...junk])).toEqual(kept);
  const two = [
    { op: "resolve_plot_thread", thread: "One thread." },
    { op: "resolve_plot_thread", thread: "Another thread." },
  ];
  expect(usableOperations([...kept, ...two])).toEqual(kept);
  expect(usableOperations([...kept, two[0]])).toEqual([...kept, two[0]]);
  // Lore Entries likewise, as a reply wiped nine of ten; one entry named twice is one remove, left to the loop check.
  const lore = [
    { op: "remove_lore_entry", title: "The mill" },
    { op: "remove_lore_entry", title: "The chapel" },
  ];
  expect(usableOperations([...kept, ...lore])).toEqual(kept);
  expect(usableOperations([...kept, lore[0], lore[0]])).toEqual([...kept, lore[0], lore[0]]);
});

test("a reply changes a record once, so a chain of rewrites keeps only its first link", () => {
  const first = { op: "update_plot_thread", thread: "A", now: "a", plan: null, truth: "B" } as const;
  const fact = { op: "update_known_fact", fact: "B", replacement: "C" } as const;
  const chain = [
    first,
    { op: "update_plot_thread", thread: "B", now: "b", plan: null, truth: "C" } as const,
    { op: "update_plot_thread", thread: "C", now: "c", plan: null, truth: "D" } as const,
  ];
  expect(withoutLoop([...chain, fact], 30)).toEqual([first, fact]);
  // A rewrite of its now alone keeps the thread's truth, so it is no link of a chain.
  const moves = [
    { op: "update_plot_thread", thread: "A", now: "a", plan: null, truth: null } as const,
    { op: "update_known_fact", fact: "A", replacement: "B" } as const,
  ];
  expect(withoutLoop(moves, 30)).toEqual(moves);
});

test("a bare quoted line after the PC's paragraph is kept as written, as it may be someone else's question", async () => {
  const text = 'Ash took the back bench while the coroner opened the report.\n\n"Do you stand by it?"\n\n"I do, sir."';
  play([narrated(text)]);
  const id = await app.createSave();

  const log = await logOf(() => streamTurn(id, "I sit down.").then(turnEvents));

  expect((await storedMessages(id)).at(-1)!.text).toBe(text);
  expect(log).not.toContain("Bare speech dropped");
});

test("a speaker label that shortens one known name, by its first words or initials, is written as that name", () => {
  const names = ["Reverend Amos Thorne", "Amos Kell", "Kit Rowan"];
  const reply = '[Reverend Amos T.]: "A sad morning."\n\n[Reverend A. Thorne]: "Yes."\n\n[Amos]: "Two Amoses."\n\n[Kit]: "Me."\n\n[Voice in the dark]: "Who?"';
  expect(withKnownSpeakers(reply, names)).toBe(
    '[Reverend Amos Thorne]: "A sad morning."\n\n[Reverend Amos Thorne]: "Yes."\n\n[Amos]: "Two Amoses."\n\n[Kit]: "Me."\n\n[Voice in the dark]: "Who?"',
  );
});

test("a summary cut to under two-fifths of the last is not taken, as a reply that did so had started the story again", async () => {
  const reply = (summary: string) => [delta(JSON.stringify({ check: null, narration: "The tide rises.", state_operations: [], summary })), "data: [DONE]\n\n"];
  play([reply("one two three four five six seven eight nine ten"), reply("one two three")]);
  const id = await app.createSave();
  await streamTurn(id, "I wait.").then(turnEvents);

  const log = await logOf(() => streamTurn(id, "I wait again.").then(turnEvents));

  expect(log).toMatch(/Summary kept .*"was":10,"now":3/);
});

test("a reply that sets the clock back within the day and adds again what the PC knew is written again, as it had started the story over", async () => {
  const fact = { op: "add_known_fact", fact: "The keeper drowned." };
  const time = (time_of_day: string) => ({ op: "set_story_time", days_passed: 0, date: "1st of Lowtide", time_of_day });
  play([
    narrated("Evening falls.", time("evening"), fact),
    narrated("Morning. The keeper is dead.", time("morning"), fact),
    narrated("The lamps are lit.", time("night")),
  ]);
  const id = await app.createSave();
  await app.post(`/saves/${id}/turns`, { input: "I wait." });

  expect((await app.post(`/saves/${id}/turns`, { input: "I wait again." })).status).toBe(201);

  expect(provider.requests).toHaveLength(3);
  expect((await storedMessages(id)).at(-1)!.text).toBe("The lamps are lit.");
});

test("an opening must bring on each Important Character its Starting Hook names, by full name or a part of it", () => {
  expect(peopleLeftOut("Vane watched the road while Tamsin drove.", ["Captain Vane", "Tamsin", "Jory"])).toEqual(["Jory"]);
  expect(peopleLeftOut("The boy, Jory, ran ahead.", ["Jory"])).toEqual([]);
});

test("a sign or a title in quotes isn't speech, and a name inside another word doesn't count as meeting someone", () => {
  expect(speechOutsideLines('A sign over the door reads "THE RED LION".')).toBe(false);
  expect(peopleLeftOut("She sat leeward, annoyed.", ["Ann Lee"])).toEqual(["Ann Lee"]);
});
