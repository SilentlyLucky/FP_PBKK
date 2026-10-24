export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "promptlab.theme";

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light";
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function readStoredPreference(
  storage: ThemeStorage | null | undefined,
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeStoredPreference(
  storage: ThemeStorage | null | undefined,
  value: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Penyimpanan bisa diblokir; tema tetap berlaku untuk sesi ini.
  }
}

/** Skrip sebelum cat pertama. Harus tetap sinkron dengan resolveTheme. */
export const THEME_INIT_SCRIPT = `(function(){try{var p="system";try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");if(s==="dark"||s==="light"||s==="system")p=s}catch(e){}var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=p==="system"?(d?"dark":"light"):p;var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t}catch(e){}})();`;
