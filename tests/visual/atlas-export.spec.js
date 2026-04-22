import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { gotoHomepageReady } from "./home-helpers.js";

// Trigger atlas export in the live app, capture the downloaded ZIP, unzip
// it, and stage the contents into demo/pixi/ so the PixiJS comparison page
// can consume them. Also asserts the .basis file is well-formed.
test("export atlas ZIP and stage demo assets", async ({ page }) => {
  await gotoHomepageReady(
    page,
    process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:5173",
  );

  page.on("dialog", (d) => d.accept());
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });

  await page.evaluate(async () => {
    const mod = await import("/sources/state/atlas-export.js");
    await mod.exportAtlas();
  });

  const download = await downloadPromise;
  const demoDir = path.join(process.cwd(), "demo", "pixi");
  const zipPath = path.join(demoDir, "character-atlas.zip");
  await download.saveAs(zipPath);

  const fileInfo = await page.evaluate(async (zipB64) => {
    const bin = Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0));
    const zip = await window.JSZip.loadAsync(bin);
    const files = {};
    for (const [name, entry] of Object.entries(zip.files)) {
      files[name] = Array.from(await entry.async("uint8array"));
    }
    return files;
  }, fs.readFileSync(zipPath).toString("base64"));

  for (const [name, bytes] of Object.entries(fileInfo)) {
    fs.writeFileSync(path.join(demoDir, name), Buffer.from(bytes));
  }

  // KTX2 magic: AB 4B 54 58 20 32 30 BB 0D 0A 1A 0A («KTX 20»\r\n\x1A\n)
  const ktx2 = fileInfo["character-atlas.ktx2"];
  expect(ktx2, ".ktx2 present").toBeDefined();
  expect(ktx2.length, ".ktx2 non-empty").toBeGreaterThan(100);
  expect(ktx2.slice(0, 12)).toEqual([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
});
