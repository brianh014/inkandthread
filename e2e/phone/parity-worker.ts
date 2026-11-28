// The scenario in a browser worker, on the phone build's stand-ins over the real SAH pool.
import "../../src/browser/globals";
import { saveStore } from "../../src/save-store";
import { openStorage } from "../../src/browser/storage";
import { storageScenario } from "./storage-scenario";

try {
  await openStorage();
  postMessage({ result: storageScenario(saveStore("/Saves")) });
} catch (error) {
  postMessage({ error: String((error as Error)?.stack ?? error) });
}
