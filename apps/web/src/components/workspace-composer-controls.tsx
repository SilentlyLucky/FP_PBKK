"use client";

import { ChevronDown } from "lucide-react";

import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";

import styles from "./workspace-conversation.module.css";

export interface ComposerChoiceOption {
  value: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

/** Pill menu di composer. Nama aksesibel: "{nama}: {nilai}". */
export function ComposerChoicePill({
  id,
  name,
  visibleName,
  value,
  options,
  disabled,
  describedBy,
  onValueChange,
}: {
  id: string;
  /** Nama aksesibel; label trigger menjadi "{nama}: {nilai}". */
  name: string;
  /** Teks nama yang terlihat di pill ("Thinking"); tanpa ini hanya nilainya yang tampil. */
  visibleName?: string | undefined;
  value: string;
  options: ComposerChoiceOption[];
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
  onValueChange: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value);
  const valueLabel = current?.label ?? value;
  return (
    <Menu>
      <MenuTrigger
        id={id}
        className={`${styles.pill}${visibleName ? " " + styles.pillWide : ""}`}
        disabled={disabled}
        aria-label={`${name}: ${valueLabel}`}
        aria-describedby={describedBy}
      >
        <span className={styles.pillFace}>
          {visibleName ? (
            <span className={styles.pillName}>{visibleName}</span>
          ) : null}
          <span className={visibleName ? styles.pillValueAccent : undefined}>
            {valueLabel}
          </span>
          <ChevronDown aria-hidden="true" size={14} />
        </span>
      </MenuTrigger>
      <MenuContent side="top" align="start" className={styles.pillMenu}>
        <MenuRadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              {...(option.disabled ? { disabled: true } : {})}
              {...(option.description
                ? { description: option.description }
                : {})}
            >
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
