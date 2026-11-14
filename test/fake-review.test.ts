import { expect, test } from "bun:test";
import { fakeTextProvider } from "../src/fake-services";
import { settingsStore } from "../src/settings-store";
import { reviewScenePrompt } from "../src/world-creation";
import { tempFolder } from "./support";

test("the fake Narrator hands a picture's prompt back from its review as it was", async () => {
  process.env.FAKE_STREAM_MS = "0";
  const folder = tempFolder();
  const scene = '[Ash: a short person] kneels, "quoted", by the fire. {Same people.}';
  const settings = settingsStore(`${folder.path}/settings.json`);
  expect(await reviewScenePrompt({ textProvider: fakeTextProvider, settings }, scene, "prose", new AbortController().signal)).toBe(scene);
  folder.remove();
});
