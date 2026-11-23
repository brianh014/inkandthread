import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { TONES } from "../src/tones";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let app: ReturnType<typeof startApp>;

beforeEach(() => {
  folder = tempFolder();
});

afterEach(async () => {
  await app.stop();
  folder.remove();
});

const WRY = `Wry: ${TONES.Wry}`;

test("a Tone set in the Journal is sent with the next Turn, late and outside the state, and none sends nothing", async () => {
  const provider = scriptedTextProvider(narration("Rain."), narration("More rain."));
  app = startApp(join(folder.path, "Saves"), provider.textProvider);
  const id = await app.createSave();
  const lastSystem = () => provider.prompts.at(-1)!.findLast(({ role }) => role === "system")!.content as string;

  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  expect(lastSystem()).not.toContain("Tell the story in this tone");

  expect((await app.post(`/saves/${id}/edits`, { edit: "tone", text: WRY })).status).toBe(200);
  expect(((await app.get(`/saves/${id}`).then((r) => r.json())) as { tone: string }).tone).toBe(WRY);
  await app.post(`/saves/${id}/turns`, { input: "I wait." });
  expect(lastSystem()).toContain(`Tell the story in this tone: ${JSON.stringify(WRY)}`);
  expect(lastSystem().match(/Current state.*$/m)![0]).not.toContain("Wry");
});

test("an own Tone longer than a line is refused", async () => {
  app = startApp(join(folder.path, "Saves"), scriptedTextProvider().textProvider);
  const id = await app.createSave();
  expect((await app.post(`/saves/${id}/edits`, { edit: "tone", text: "x".repeat(151) })).status).toBe(400);
});
