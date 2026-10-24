"use client";

import { useEffect, useState } from "react";

/**
 * Membaca token CSS (mis. "--graph-edge") sebagai string warna terhitung.
 * Props SVG/React Flow tidak selalu mengurai var(), jadi nilai dibaca dari
 * <html> dan diperbarui saat atribut data-theme berubah.
 * Nilai awal kosong sampai hidrasi selesai supaya markup server tetap sama.
 */
export function useThemeTokens<const Name extends string>(
  names: readonly Name[],
): Record<Name, string> {
  const [values, setValues] = useState<Record<Name, string>>(
    () =>
      Object.fromEntries(names.map((name) => [name, ""])) as Record<
        Name,
        string
      >,
  );
  const key = names.join("|");

  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const styles = getComputedStyle(root);
      const next = Object.fromEntries(
        key
          .split("|")
          .map((name) => [name, styles.getPropertyValue(name).trim()]),
      ) as Record<Name, string>;
      setValues((current) =>
        Object.keys(next).every(
          (name) => current[name as Name] === next[name as Name],
        )
          ? current
          : next,
      );
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, [key]);

  return values;
}
