// Opens the phone build's storage and says how it went, for the one-tab check in phone-storage.spec.ts.
import "../../src/browser/globals";
import { OpenElsewhere, openStorage } from "../../src/browser/storage";

try {
  await openStorage();
  postMessage("opened");
} catch (error) {
  postMessage(error instanceof OpenElsewhere ? "open elsewhere" : String(error));
}
