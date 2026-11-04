/**
 * Vitest DOM setup — restores the Web Storage API inside jsdom.
 * ---------------------------------------------------------------------------
 * Node 24+ exposes an experimental global `localStorage` / `sessionStorage`
 * that is `undefined` unless the process runs with `--localstorage-file`.
 * Vitest copies jsdom's globals onto `globalThis` without overwriting keys that
 * already exist there, so the Node stubs shadow jsdom's working implementations
 * and every `localStorage.setItem(...)` call throws
 * "Cannot read properties of undefined".
 *
 * Fix: when the Web Storage API is missing, back `Storage.prototype` with an
 * in-memory Map and hand out instances created from that prototype. Keeping the
 * methods on `Storage.prototype` (instead of own properties) preserves the
 * existing test contract — tests spy on `Storage.prototype.setItem/getItem/
 * removeItem` to simulate quota/security failures, and those spies must still
 * intercept the app's calls.
 *
 * Nothing changes when storage is already usable (older Node, real browser).
 * ---------------------------------------------------------------------------
 */

/** Per-instance backing store, so `localStorage` and `sessionStorage` differ. */
const storageState = new WeakMap<object, Map<string, string>>();

function stateFor(self: object): Map<string, string> {
  let map = storageState.get(self);
  if (map === undefined) {
    map = new Map<string, string>();
    storageState.set(self, map);
  }
  return map;
}

function installMemoryStorage(): void {
  Object.defineProperties(Storage.prototype, {
    getItem: {
      configurable: true,
      writable: true,
      value: function getItem(this: object, key: string): string | null {
        const value = stateFor(this).get(String(key));
        return value === undefined ? null : value;
      },
    },
    setItem: {
      configurable: true,
      writable: true,
      value: function setItem(this: object, key: string, value: string): void {
        stateFor(this).set(String(key), String(value));
      },
    },
    removeItem: {
      configurable: true,
      writable: true,
      value: function removeItem(this: object, key: string): void {
        stateFor(this).delete(String(key));
      },
    },
    clear: {
      configurable: true,
      writable: true,
      value: function clear(this: object): void {
        stateFor(this).clear();
      },
    },
    key: {
      configurable: true,
      writable: true,
      value: function key(this: object, index: number): string | null {
        return Array.from(stateFor(this).keys())[index] ?? null;
      },
    },
    length: {
      configurable: true,
      get(this: object): number {
        return stateFor(this).size;
      },
    },
  });
}

function createStorage(): Storage {
  return Object.create(Storage.prototype) as Storage;
}

function isUsableStorage(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    typeof (value as Storage).setItem === 'function'
  );
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): boolean {
  const current = (globalThis as unknown as Record<string, unknown>)[name];
  if (isUsableStorage(current)) return false;

  Object.defineProperty(globalThis, name, {
    value: createStorage(),
    configurable: true,
    writable: true,
  });
  return true;
}

const needsMemoryStorage = [ensureStorage('localStorage'), ensureStorage('sessionStorage')];
if (needsMemoryStorage.some(Boolean)) {
  installMemoryStorage();
}
