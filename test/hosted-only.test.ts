import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../src/rest-api";
import { settingsStore } from "../src/settings-store";
import { scriptedDice, scriptedImages, scriptedTextProvider, tempFolder } from "./support";

// The phone app reaches only hosted services (ADR 0006), so its Settings never offer, or keep, anything else.
let folder: ReturnType<typeof tempFolder>;
let server: ReturnType<typeof startServer>;

beforeEach(() => {
  folder = tempFolder();
  server = startServer({
    savesDir: join(folder.path, "Saves"),
    settings: settingsStore(join(folder.path, "settings.json")),
    textProvider: scriptedTextProvider().textProvider,
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    ownDevice: true,
    hostedOnly: true,
  });
});

afterEach(async () => {
  await server.stop(true);
  folder.remove();
});

const patch = (change: object) =>
  fetch(new URL("/settings", server.url), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });

test("a hosted-only app tells the page so, and offers no command", async () => {
  const shown = (await (await fetch(new URL("/settings", server.url))).json()) as { hostedOnly: boolean; commandHere: boolean };
  expect(shown).toMatchObject({ hostedOnly: true, commandHere: false });
});

test("a hosted-only app refuses a local server, a command, ComfyUI and Wiro, and takes the hosted services", async () => {
  for (const unreachable of [
    { textBaseUrl: "http://localhost:1234/v1" },
    { reviewBaseUrl: "http://localhost:1234/v1" },
    { textCommand: ["llm"] },
    { imagesEnabled: true, imageProvider: "local" },
    { imagesEnabled: true, imageProvider: "wiro" },
  ]) {
    const response = await patch(unreachable);
    expect({ unreachable, status: response.status }).toEqual({ unreachable, status: 422 });
  }
  expect((await patch({ textBaseUrl: "https://api.nano-gpt.com/api/v1", textModel: "a-model", imagesEnabled: true, imageProvider: "google" })).status).toBe(
    200,
  );
  // Pictures off may name any provider, as none is called.
  expect((await patch({ imagesEnabled: false, imageProvider: "local" })).status).toBe(200);
});
