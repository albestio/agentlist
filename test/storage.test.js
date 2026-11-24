import test from "node:test";
import assert from "node:assert/strict";
import { readStoredEcosystem, storeEcosystem, isValidEcosystem } from "../public/storage.js";

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    get raw() { return Object.fromEntries(map); },
  };
}

test("a valid stored ecosystem is restored, anything else falls back to pi", () => {
  assert.equal(readStoredEcosystem(memoryStorage({ "agentList.ecosystem": "claude" })), "claude");
  assert.equal(readStoredEcosystem(memoryStorage({ "agentList.ecosystem": "both" })), "both");
  assert.equal(readStoredEcosystem(memoryStorage({ "agentList.ecosystem": "emacs" })), "pi");
  assert.equal(readStoredEcosystem(memoryStorage({})), "pi");
  assert.equal(readStoredEcosystem(memoryStorage({ "agentList.ecosystem": "" })), "pi");
});

test("an unavailable or throwing storage never breaks the page", () => {
  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  assert.equal(readStoredEcosystem(broken), "pi");
  assert.equal(readStoredEcosystem(undefined), "pi");
  assert.equal(storeEcosystem(broken, "claude"), false);
  assert.equal(storeEcosystem(undefined, "claude"), false);
});

test("only known ecosystems are persisted", () => {
  const storage = memoryStorage({});
  assert.equal(storeEcosystem(storage, "both"), true);
  assert.deepEqual(storage.raw, { "agentList.ecosystem": "both" });
  assert.equal(storeEcosystem(storage, "vi"), false);
  assert.deepEqual(storage.raw, { "agentList.ecosystem": "both" });
  assert.equal(isValidEcosystem("pi"), true);
  assert.equal(isValidEcosystem("PI"), false);
  assert.equal(isValidEcosystem(null), false);
});
