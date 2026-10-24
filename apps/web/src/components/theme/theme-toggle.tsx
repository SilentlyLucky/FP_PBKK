"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  isThemePreference,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type ThemePreference,
} from "@/lib/theme";

const options: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Ikuti sistem" },
  { value: "dark", label: "Gelap" },
  { value: "light", label: "Terang" },
];

function applyTheme(preference: ThemePreference) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = resolveTheme(preference, prefersDark);
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    // Preferensi hanya ada di browser; dibaca setelah hidrasi supaya markup server tetap sama.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreference(readStoredPreference(window.localStorage));
  }, []);

  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme("system");
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [preference]);

  const choose = useCallback((value: string) => {
    if (!isThemePreference(value)) return;
    setPreference(value);
    writeStoredPreference(window.localStorage, value);
    applyTheme(value);
  }, []);

  const Icon =
    preference === "dark" ? Moon : preference === "light" ? Sun : Laptop;
  const current = options.find((option) => option.value === preference);

  return (
    <Menu>
      <MenuTrigger
        aria-label="Tema tampilan"
        title="Tema tampilan"
        className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground data-[state=open]:bg-active data-[state=open]:text-foreground"
      >
        <Icon aria-hidden="true" size={16} />
        <span className="nav-label">{current?.label}</span>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="min-w-[180px]">
        <MenuRadioGroup value={preference} onValueChange={choose}>
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
