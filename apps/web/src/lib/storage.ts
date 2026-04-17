import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

interface BeforeUnloadRegistry {
  callbacks: Map<string, () => void>;
  listenerAttached: boolean;
}

declare global {
  interface Window {
    __shioricodeBeforeUnloadRegistry__?: BeforeUnloadRegistry;
  }
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

function ensureBeforeUnloadRegistry(): BeforeUnloadRegistry | null {
  if (typeof window === "undefined") {
    return null;
  }

  const existing = window.__shioricodeBeforeUnloadRegistry__;
  if (existing) {
    return existing;
  }

  const registry: BeforeUnloadRegistry = {
    callbacks: new Map(),
    listenerAttached: false,
  };
  window.__shioricodeBeforeUnloadRegistry__ = registry;
  return registry;
}

export function registerBeforeUnloadCallback(key: string, callback: () => void): void {
  const registry = ensureBeforeUnloadRegistry();
  if (!registry) {
    return;
  }

  registry.callbacks.set(key, callback);
  if (registry.listenerAttached) {
    return;
  }

  window.addEventListener("beforeunload", () => {
    for (const flush of registry.callbacks.values()) {
      flush();
    }
  });
  registry.listenerAttached = true;
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
