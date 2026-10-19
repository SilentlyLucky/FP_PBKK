import { expect, test } from "@playwright/test";

const productPages = [
  ["/workspace", "Workspace"],
  ["/sources", "Sumber"],
  ["/experiments", "Pengujian"],
  ["/monitoring", "Monitoring"],
  ["/settings", "Pengaturan"],
] as const;

test("five navigation destinations are reachable and capabilities stay honest", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(navigation.getByRole("link")).toHaveCount(5);

  await expect(
    page.getByText(
      "Setiap pesan dioptimasi Senopati lalu otomatis dijalankan Codex. Versi prompt tersimpan tidak diaktifkan otomatis.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pesan" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Kirim", exact: true }),
  ).toBeDisabled();

  for (const [route, heading] of productPages) {
    const link = navigation.getByRole("link", { name: heading });
    await expect(link).toHaveAttribute("href", route);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${route}/?$`));
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
});

test("five product pages reflow without page-level horizontal scrolling", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const width of [320, 360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, heading] of productPages) {
      await page.goto(route);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        interactiveTargets: Array.from(
          document.querySelectorAll(
            "button, input, select, textarea, a.nav-link",
          ),
        )
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => {
            const target =
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type) &&
              element.labels?.length === 1
                ? element.labels[0]!
                : element;
            const bounds = target.getBoundingClientRect();
            return {
              width: bounds.width,
              height: bounds.height,
              element: target.tagName.toLowerCase(),
              id: target.id,
              label:
                target.getAttribute("aria-label") ??
                target.textContent?.trim().replace(/\s+/gu, " ").slice(0, 50) ??
                "",
            };
          }),
      }));
      expect(
        dimensions.documentWidth,
        `${route} at ${width}px should not overflow the viewport`,
      ).toBeLessThanOrEqual(dimensions.viewportWidth);
      for (const target of dimensions.interactiveTargets) {
        expect(
          target.width,
          `${route} target ${target.element}#${target.id} ${target.label} should be at least 44px wide`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          target.height,
          `${route} target ${target.element}#${target.id} ${target.label} should be at least 44px tall`,
        ).toBeGreaterThanOrEqual(44);
      }
    }
  }
});

test("rendered text, control boundaries, and keyboard focus meet contrast thresholds", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/workspace");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(
      page.getByRole("link", { name: "Status target Codex" }),
    ).toBeVisible();
    const preference = page.locator("#workspace-preference");
    await preference.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(preference).toBeFocused();

    const ratios = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas color measurement is unavailable");

      const pixel = (
        color: string,
        background: [number, number, number] = [255, 255, 255],
      ): [number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = `rgb(${background.join(",")})`;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = context.getImageData(0, 0, 1, 1).data;
        return [channels[0]!, channels[1]!, channels[2]!];
      };
      const luminance = (color: string) => {
        const channels = pixel(color).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
        );
      };
      const contrast = (foreground: string, background: string) => {
        const values = [luminance(foreground), luminance(background)].sort(
          (a, b) => b - a,
        );
        return Number(((values[0]! + 0.05) / (values[1]! + 0.05)).toFixed(2));
      };
      const backgroundFor = (element: Element) => {
        const ancestors: Element[] = [];
        let current: Element | null = element;
        while (current) {
          ancestors.push(current);
          current = current.parentElement;
        }
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#fff";
        context.fillRect(0, 0, 1, 1);
        for (const ancestor of ancestors.reverse()) {
          context.fillStyle = getComputedStyle(ancestor).backgroundColor;
          context.fillRect(0, 0, 1, 1);
        }
        const channels = context.getImageData(0, 0, 1, 1).data;
        return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
      };
      const sample = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing contrast sample: ${selector}`);
        return { element, computed: getComputedStyle(element) };
      };
      const body = sample("body");
      const helper = sample("#workspace-title + p");
      const heading = sample("#workspace-title");
      const activeNavigation = sample('.nav-link[aria-current="page"]');
      const providerStatus = sample(".readiness-link > span");
      const control = sample("#workspace-preference");
      return {
        bodyText: contrast(body.computed.color, body.computed.backgroundColor),
        helperText: contrast(
          helper.computed.color,
          backgroundFor(helper.element),
        ),
        pageHeading: contrast(
          heading.computed.color,
          backgroundFor(heading.element),
        ),
        activeNavigation: contrast(
          activeNavigation.computed.color,
          backgroundFor(activeNavigation.element),
        ),
        providerStatus: contrast(
          providerStatus.computed.color,
          backgroundFor(providerStatus.element),
        ),
        controlBoundary: contrast(
          control.computed.borderTopColor,
          control.computed.backgroundColor,
        ),
        focusIndicator: contrast(
          control.computed.outlineColor,
          control.computed.backgroundColor,
        ),
        focusOutlineWidth: control.computed.outlineWidth,
      };
    });
    console.log(`rendered-contrast ${colorScheme} ${JSON.stringify(ratios)}`);
    expect(ratios.bodyText).toBeGreaterThanOrEqual(4.5);
    expect(ratios.helperText).toBeGreaterThanOrEqual(4.5);
    expect(ratios.pageHeading).toBeGreaterThanOrEqual(3);
    expect(ratios.activeNavigation).toBeGreaterThanOrEqual(4.5);
    expect(ratios.providerStatus).toBeGreaterThanOrEqual(4.5);
    expect(ratios.controlBoundary).toBeGreaterThanOrEqual(3);
    expect(ratios.focusIndicator).toBeGreaterThanOrEqual(3);
    expect(ratios.focusOutlineWidth).toBe("2px");
  }
});
