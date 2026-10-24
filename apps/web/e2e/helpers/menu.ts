import { expect, type Locator, type Page } from "@playwright/test";

/** Trigger menu kustom bernama "{nama}: {nilai}" (mis. "Gaya jawaban: Seimbang"). */
export function menuTrigger(page: Page, name: string): Locator {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped}:`, "u") });
}

export async function chooseMenuOption(
  page: Page,
  triggerName: string,
  optionName: string,
) {
  await menuTrigger(page, triggerName).click();
  await page
    .getByRole("menuitemradio", { name: optionName, exact: true })
    .click();
}

export async function expectMenuValue(
  page: Page,
  triggerName: string,
  valueLabel: string,
) {
  await expect(menuTrigger(page, triggerName)).toHaveAccessibleName(
    `${triggerName}: ${valueLabel}`,
  );
}
