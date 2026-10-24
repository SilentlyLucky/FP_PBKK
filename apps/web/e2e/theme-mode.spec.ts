import { expect, test } from "@playwright/test";

const routes = [
  "/workspace",
  "/sources",
  "/experiments",
  "/monitoring",
  "/settings",
];

test("follows the system color scheme by default", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/sources");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("keeps the chosen theme after reload and page changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/sources");

  await page.getByRole("button", { name: "Tema tampilan" }).click();
  await page.getByRole("menuitemradio", { name: "Terang" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("link", { name: "Pengaturan", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Tema tampilan" }).click();
  await page.getByRole("menuitemradio", { name: "Gelap" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Tema tampilan" }).click();
  await page.getByRole("menuitemradio", { name: "Ikuti sistem" }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const theme of ["dark", "light"] as const) {
  test(`has no horizontal overflow at 390px in ${theme} mode`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      window.localStorage.setItem("promptlab.theme", value);
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${route} in ${theme}`).toBeLessThanOrEqual(0);
    }
  });
}
