import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { projectPicker } from "./helpers/project-picker";

const viewportSizes = [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
  [768, 1024],
  [390, 844],
] as const;
const primaryRoutes = [
  { href: "/workspace", name: "Workspace" },
  { href: "/sources", name: "Sumber" },
  { href: "/experiments", name: "Pengujian" },
  { href: "/monitoring", name: "Monitoring" },
  { href: "/settings", name: "Pengaturan" },
] as const;

async function installEmptyShellFixtures(
  page: import("@playwright/test").Page,
) {
  const unexpectedRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/projects" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ projects: [] }),
      });
      return;
    }
    if (url.pathname === "/api/providers" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [],
          codexModels: [],
          projectPrerequisite: "missing",
        }),
      });
      return;
    }
    unexpectedRequests.push(`${method} ${url.pathname}`);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unexpected shell fixture request" }),
    });
  });
  return { unexpectedRequests };
}

function colorChannels(color: string): [number, number, number] {
  const channels = color
    .match(/[\d.]+/gu)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`Cannot measure contrast for color: ${color}`);
  }
  return [channels[0]!, channels[1]!, channels[2]!];
}

function luminance(color: string): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = colorChannels(color);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("Workspace shell reflows without horizontal overflow", async ({
  page,
}) => {
  const fixture = await installEmptyShellFixtures(page);
  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace" }),
  ).toBeVisible();
  await expect(projectPicker(page)).toHaveAttribute(
    "aria-label",
    "Proyek: Belum ada proyek",
    { timeout: 20_000 },
  );
  await expect(
    page.getByRole("heading", { level: 3, name: "Pilih proyek untuk mulai" }),
  ).toBeVisible();
  await expect(page.locator("#workspace-message")).toBeDisabled();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focusedControl = await page.evaluate(() => {
    function backgroundFor(element: Element): string {
      let current: Element | null = element;
      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
          return background;
        }
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    }

    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    return {
      label: element.getAttribute("aria-label"),
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      comparisonBackgroundColor: backgroundFor(
        element.parentElement ?? element,
      ),
    };
  });
  if (!focusedControl) throw new Error("The keyboard focus target is missing.");
  expect(focusedControl?.label).toBe("Buka navigasi");
  expect(focusedControl?.outlineStyle).not.toBe("none");
  const focusShadowColor =
    focusedControl.boxShadow.match(/rgba?\([^)]+\)/u)?.[0];
  if (!focusShadowColor) throw new Error("The mobile focus ring is missing.");
  const focusContrast = contrastRatio(
    focusShadowColor,
    focusedControl.comparisonBackgroundColor,
  );

  for (const [width, height] of viewportSizes) {
    await page.setViewportSize({ width, height });
    await page.goto("/workspace");
    await expect(
      page.getByRole("heading", { level: 1, name: "Workspace" }),
    ).toBeVisible();
    if (width <= 640) {
      const toggle = page.getByRole("button", { name: "Buka navigasi" });
      await toggle.click();
      await expect(
        page
          .getByRole("navigation", { name: "Navigasi utama" })
          .getByRole("link"),
      ).toHaveCount(5);
      await page.getByRole("button", { name: "Tutup navigasi" }).click();
    } else {
      await expect(
        page
          .getByRole("navigation", { name: "Navigasi utama" })
          .getByRole("link"),
      ).toHaveCount(5);
    }

    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth,
    );

    const contextButton = page
      .getByTestId("workspace-chat-panel")
      .getByRole("button", { name: "Konteks", exact: true });
    if (width > 1360) {
      await expect(
        page.getByRole("complementary", { name: "Konteks percakapan" }),
      ).toBeVisible();
    } else {
      await expect(contextButton).toHaveAttribute("aria-expanded", "false");
      await contextButton.click();
      await expect(
        page.getByRole("complementary", { name: "Konteks percakapan" }),
      ).toBeVisible();
      if (width === 1280 || width === 390) {
        await page.screenshot({
          path: resolve(screenshotDirectory, `workspace-${width}-context.png`),
          fullPage: true,
          style: "nextjs-portal { display: none !important; }",
        });
      }
      await page
        .getByRole("complementary", { name: "Konteks percakapan" })
        .getByRole("button", { name: "Tutup panel konteks" })
        .click();
      await expect(contextButton).toHaveAttribute("aria-expanded", "false");
    }

    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    const composerBottomGap = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(
        '[data-testid="workspace-chat-panel"]',
      );
      const composer = document.querySelector<HTMLElement>(
        "#workspace-composer",
      );
      if (!panel || !composer) return Number.POSITIVE_INFINITY;
      return Math.round(
        panel.getBoundingClientRect().bottom -
          composer.getBoundingClientRect().bottom,
      );
    });
    expect(
      composerBottomGap,
      `the composer should stay docked at ${width}px`,
    ).toBeLessThanOrEqual(24);
    await page.screenshot({
      path: resolve(screenshotDirectory, `workspace-${width}.png`),
      fullPage: true,
      style: "nextjs-portal { display: none !important; }",
    });
  }

  const contrastInputs = await page.evaluate(() => {
    function backgroundFor(element: Element): string {
      let current: Element | null = element;
      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
          return background;
        }
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    }

    return [
      ["workspace heading", "h1"],
      ["inactive navigation", ".nav-link:not([aria-current])"],
      ["active navigation", '.nav-link[aria-current="page"]'],
      ["composer help", "#workspace-composer-help"],
      ["project selector boundary", "#active-project"],
    ].flatMap(([label, selector]) => {
      const element = document.querySelector(selector!);
      if (!element) return [];
      const style = getComputedStyle(element);
      const foreground =
        label === "project selector boundary"
          ? style.borderTopColor
          : style.color;
      const background = backgroundFor(element);
      return [{ label, foreground, background }];
    });
  });
  const measuredContrast = [
    ...contrastInputs.map(({ label, foreground, background }) => ({
      label,
      ratio: contrastRatio(foreground, background),
      minimum: label === "project selector boundary" ? 3 : 4.5,
    })),
    {
      label: "mobile navigation focus indicator",
      ratio: focusContrast,
      minimum: 3,
    },
  ];
  expect(measuredContrast).toHaveLength(6);
  console.info(
    `Rendered contrast ratios: ${measuredContrast
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}:1`)
      .join(
        "; ",
      )}; mobile focus ring ${focusShadowColor} on ${focusedControl.comparisonBackgroundColor}`,
  );
  for (const sample of measuredContrast) {
    expect(sample.ratio, `${sample.label} contrast`).toBeGreaterThanOrEqual(
      sample.minimum,
    );
  }
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("all five primary navigation entries open their product routes", async ({
  page,
}) => {
  const fixture = await installEmptyShellFixtures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/workspace");
  const navigation = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(navigation.getByRole("link")).toHaveCount(5);

  for (const route of primaryRoutes) {
    const link = navigation.getByRole("link", { name: route.name });
    await expect(link).toHaveAttribute("href", route.href);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${route.href}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: route.name }),
    ).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("five primary pages render at desktop and narrow widths", async ({
  page,
}) => {
  const fixture = await installEmptyShellFixtures(page);
  const screenshotDirectory = resolve(
    process.cwd(),
    "docs/implementation/screenshots",
  );
  await mkdir(screenshotDirectory, { recursive: true });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of primaryRoutes) {
      await page.goto(route.href);
      const navigation = page.getByRole("navigation", {
        name: "Navigasi utama",
      });
      if (width <= 640) {
        await page.getByRole("button", { name: "Buka navigasi" }).click();
        await expect(navigation.getByRole("link")).toHaveCount(5);
        await page.getByRole("button", { name: "Tutup navigasi" }).click();
      } else {
        await expect(navigation.getByRole("link")).toHaveCount(5);
      }
      await expect(page).toHaveURL(new RegExp(`${route.href}$`));
      await expect(
        page.getByRole("heading", { level: 1, name: route.name }),
      ).toBeVisible();
      const dimensions = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth,
          offenders: Array.from(
            document.querySelectorAll<HTMLElement>("body *"),
          )
            .map((element) => ({
              element,
              bounds: element.getBoundingClientRect(),
            }))
            .filter(
              ({ bounds }) =>
                bounds.width > 0 && bounds.right > viewportWidth + 1,
            )
            .slice(0, 8)
            .map(({ element, bounds }) => ({
              tag: element.tagName,
              className: element.className,
              text: element.innerText.slice(0, 60),
              left: Math.round(bounds.left),
              right: Math.round(bounds.right),
              width: Math.round(bounds.width),
            })),
        };
      });
      expect(
        dimensions.documentWidth,
        `${route.href} at ${width}px has overflow: ${JSON.stringify(dimensions.offenders)}`,
      ).toBeLessThanOrEqual(dimensions.viewportWidth);
      const slug = route.href.slice(1);
      await page.mouse.move(0, 0);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
      await page.screenshot({
        path: resolve(
          screenshotDirectory,
          `browser-acceptance-${slug}-${width}.png`,
        ),
        fullPage: true,
        style: "nextjs-portal { display: none !important; }",
      });
    }
  }
  expect(fixture.unexpectedRequests).toEqual([]);
});
