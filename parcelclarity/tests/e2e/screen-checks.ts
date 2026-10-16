import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Checks shared by the specs that look at whole screens: automated WCAG 2.1 A/AA with axe-core (serious and critical
 * violations fail), and the phone layout rules the app promises: nothing scrolls sideways, inputs are at least 16px
 * (iOS zooms into smaller ones), and every control is at least 44px tall. Automated checks catch about a third of
 * accessibility problems; the manual review is tracked in IMPLEMENTATION_STATUS.md.
 */
export async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")} :: ${n.any[0]?.message ?? ""}`).join("\n")}`)).toEqual([]);
}

/** The page is no wider than the window (a table may scroll inside its own box, the page may not). */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `${label}: the page scrolls sideways (${widths.scroll}px of ${widths.client}px)`).toBeLessThanOrEqual(widths.client);
}

/** Overflow, input font size and 44px targets on a phone-sized page. A radio or checkbox is tapped through its label, so the label's box is the target. */
export async function expectPhoneLayout(page: Page, label: string) {
  await expectNoHorizontalScroll(page, label);
  const sizes = await page.locator("input:not([type=hidden]), select, textarea").evaluateAll((els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  if (sizes.length) expect(Math.min(...sizes), `${label}: input font size`).toBeGreaterThanOrEqual(16);
  const smallTargets = await page.locator("button, a, input:not([type=hidden]), select, summary").evaluateAll((els) =>
    els
      .filter((el) => !el.classList.contains("sr-only"))
      .map((el) => {
        const type = (el as HTMLInputElement).type;
        const target = (type === "radio" || type === "checkbox") && el.closest("label") ? el.closest("label")! : el;
        return { el, rect: target.getBoundingClientRect() };
      })
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 44)
      .map(({ el }) => el.outerHTML.slice(0, 120)),
  );
  expect(smallTargets, `${label}: touch targets under 44px`).toEqual([]);
}
