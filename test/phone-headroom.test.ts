import { expect, test } from "bun:test";
import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { keepHeadroom } from "../src/browser/storage";

test("a phone whose storage can't grow still answers, so its stories can be exported and deleted", async () => {
  const full = { getCapacity: () => 64, getFileCount: () => 60, addCapacity: () => Promise.reject(new Error("QuotaExceededError")) };
  await expect(keepHeadroom(full as unknown as SAHPoolUtil)).resolves.toBeUndefined();
});
