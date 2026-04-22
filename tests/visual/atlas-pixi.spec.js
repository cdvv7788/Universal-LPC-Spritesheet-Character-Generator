import { test, expect } from "@playwright/test";

// Pixi demo: two canvases (PNG + KTX2) share keyboard input. Verify both
// textures boot and render without errors.
test("PixiJS PNG vs KTX2 demo loads both textures", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    // Basis/KTX-specific warnings count; benign headless-Chrome GL perf
    // warnings ("GPU stall due to ReadPixels", "GL Driver Message") don't.
    if (
      m.type() === "warning" &&
      /ktx|basis/i.test(m.text()) &&
      !/GL Driver/i.test(m.text())
    ) {
      errors.push(`console.warn: ${m.text()}`);
    }
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    // ERR_ABORTED is benign: in-flight HEAD requests for stats panel get
    // cancelled when the test tears down. Only flag genuine load failures.
    if (!r.url().includes("favicon") && err !== "net::ERR_ABORTED") {
      errors.push(`requestfailed: ${r.url()} → ${err}`);
    }
  });

  await page.goto("http://localhost:8001/index.html", {
    waitUntil: "networkidle",
  });
  // Wait for both canvases to appear
  await page.waitForSelector("#pane-png canvas", { timeout: 15_000 });
  await page.waitForSelector("#pane-ktx2 canvas", { timeout: 15_000 });
  // One second for textures to upload and first frames to render
  await page.waitForTimeout(1500);

  expect(errors).toEqual([]);
});
