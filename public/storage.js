export const ECOSYSTEMS = ["pi", "claude", "both"];
export const STORAGE_KEY = "agentList.ecosystem";
export const DEFAULT_ECOSYSTEM = "pi";

export function isValidEcosystem(value) {
  return typeof value === "string" && ECOSYSTEMS.includes(value);
}

/** Last ecosystem the user picked, or the fallback when nothing usable is stored. */
export function readStoredEcosystem(storage, fallback = DEFAULT_ECOSYSTEM) {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isValidEcosystem(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

/** Persists an explicit choice. Unknown values, or a storage that refuses, are ignored. */
export function storeEcosystem(storage, value) {
  if (!isValidEcosystem(value)) return false;
  if (typeof storage?.setItem !== "function") return false;
  try {
    storage.setItem(STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
