// Renders the ParcelClarity mark to the PNG icon set required for the PWA / iOS Home Screen.
// Usage: node scripts/generate-icons.mjs   (uses the Chromium that Playwright is configured with)
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const ACCENT = "#0071e3";
const mark = (inset) => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
    <rect width="32" height="32" fill="${ACCENT}"/>
    <g transform="translate(16 16) scale(${inset}) translate(-16 -16)">
      <path d="M9 12.2 16 8.5l7 3.7v7.6L16 23.5 9 19.8z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M9.4 12.4 16 16l6.6-3.6M16 16v7.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
  </svg>`;

const icons = [
  { file: "icon-192.png", size: 192, inset: 1.15 },
  { file: "icon-512.png", size: 512, inset: 1.15 },
  { file: "apple-touch-icon.png", size: 180, inset: 1.15 },
  // Maskable icons must keep the artwork inside the central 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, inset: 0.9 },
];

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PC_CHROMIUM_PATH || undefined });
for (const { file, size, inset } of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${mark(inset)}</body></html>`);
  await page.screenshot({ path: `public/icons/${file}`, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log("wrote", file);
}
await browser.close();
