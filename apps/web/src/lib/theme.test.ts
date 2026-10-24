import { describe, expect, it } from "vitest";

import {
  readStoredPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  writeStoredPreference,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("theme", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit preference override the system", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("defaults to system for missing or unknown stored values", () => {
    expect(readStoredPreference(memoryStorage())).toBe("system");
    expect(
      readStoredPreference(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" })),
    ).toBe("system");
    expect(readStoredPreference(null)).toBe("system");
  });

  it("round-trips a stored preference", () => {
    const storage = memoryStorage();
    writeStoredPreference(storage, "light");
    expect(readStoredPreference(storage)).toBe("light");
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredPreference(blocked)).toBe("system");
    expect(() => writeStoredPreference(blocked, "dark")).not.toThrow();
  });
});
