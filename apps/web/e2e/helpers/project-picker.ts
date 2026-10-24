import { expect, type Page } from "@playwright/test";

/** Pemilih proyek di sidebar adalah menu kustom; trigger-nya memakai id lama `#active-project`. */
export function projectPicker(page: Page) {
  return page.locator("#active-project");
}

/** Nama proyek aktif seperti ditampilkan di trigger ("Proyek: {nama}"). */
export async function projectPickerLabel(page: Page): Promise<string> {
  const label = await projectPicker(page).getAttribute("aria-label");
  return (label ?? "").replace(/^Proyek:\s*/u, "");
}

export async function expectActiveProjectId(page: Page, projectId: string) {
  await expect(projectPicker(page)).toHaveAttribute(
    "data-active-project-id",
    projectId,
  );
}

export async function selectProject(page: Page, name: string) {
  await projectPicker(page).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

export async function selectProjectById(page: Page, projectId: string) {
  await projectPicker(page).click();
  await page
    .locator(`[role="menuitemradio"][data-project-id="${projectId}"]`)
    .click();
}
