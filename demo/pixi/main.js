// PixiJS 8 demo: two Applications side-by-side, same atlas JSON + animations,
// one backed by the PNG texture, the other by the KTX2 (UASTC + zstd).
// Pixi exports loadKTX2 in the default bundle but doesn't auto-register it.
import {
  Application,
  Assets,
  Spritesheet,
  AnimatedSprite,
  TextureStyle,
  extensions,
  loadKTX2,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8.18.1/dist/pixi.min.mjs";
extensions.add(loadKTX2);
// Pixi defaults to linear filtering; pixel art needs nearest-neighbor so
// the 2x upscale stays crisp instead of blurry.
TextureStyle.defaultOptions.scaleMode = "nearest";

const ATLAS_BASE = "character-atlas";
const VIEW = { w: 400, h: 300 };
const SCALE = 2;
const SPEED = 80;
const FRAME_RATE = 8;

const input = { left: false, right: false, up: false, down: false };
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") input.left = true;
  if (e.key === "ArrowRight") input.right = true;
  if (e.key === "ArrowUp") input.up = true;
  if (e.key === "ArrowDown") input.down = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") input.left = false;
  if (e.key === "ArrowRight") input.right = false;
  if (e.key === "ArrowUp") input.up = false;
  if (e.key === "ArrowDown") input.down = false;
});

// Which base animation names (e.g. "walk", "run", "idle") to play while
// moving vs standing still. Shared across both panes; updated by the
// dropdowns below.
const selection = { idle: "idle", walk: "walk" };

// Keep dropdowns mouse-only — arrow keys are reserved for moving the
// sprite. Skip Tab focus and swallow arrow/space/enter while the select is
// focused so they never change the value or open the dropdown via keyboard.
const BLOCKED_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  " ",
  "Enter",
]);

function disableKeyboardOn(el) {
  el.tabIndex = -1;
  el.addEventListener("keydown", (e) => {
    if (BLOCKED_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  el.addEventListener("change", () => el.blur());
}

function populateSelectors(atlasJson) {
  const bases = Object.keys(atlasJson.animations ?? {});
  const idleSelect = document.getElementById("idle-select");
  const walkSelect = document.getElementById("walk-select");
  for (const base of bases) {
    idleSelect.add(new Option(base, base));
    walkSelect.add(new Option(base, base));
  }
  if (bases.includes("idle")) idleSelect.value = "idle";
  if (bases.includes("walk")) walkSelect.value = "walk";
  selection.idle = idleSelect.value || bases[0];
  selection.walk = walkSelect.value || bases[0];
  disableKeyboardOn(idleSelect);
  disableKeyboardOn(walkSelect);
  idleSelect.addEventListener("change", () => {
    selection.idle = idleSelect.value;
  });
  walkSelect.addEventListener("change", () => {
    selection.walk = walkSelect.value;
  });
}

async function makeSpritesheet(baseTextureUrl, atlasJson) {
  const baseTexture = await Assets.load(baseTextureUrl);
  // Belt-and-braces: global default is nearest, but force it here too for
  // textures that may have been preloaded with a different style.
  baseTexture.source.style.scaleMode = "nearest";
  const sheet = new Spritesheet(baseTexture, {
    ...atlasJson,
    meta: { ...atlasJson.meta, image: baseTextureUrl },
  });
  await sheet.parse();
  return sheet;
}

function cycleTextures(sheet, atlasJson, animName, direction) {
  const names = atlasJson.animations?.[animName]?.cycle?.[direction];
  if (!names) return null;
  const textures = names.map((n) => sheet.textures[n]).filter(Boolean);
  return textures.length > 0 ? textures : null;
}

async function bootPane(paneId, textureUrl, atlasJson) {
  const app = new Application();
  await app.init({
    width: VIEW.w,
    height: VIEW.h,
    background: "#111",
    resolution: 1,
    antialias: false,
    roundPixels: true,
  });
  document.getElementById(paneId).appendChild(app.canvas);

  const sheet = await makeSpritesheet(textureUrl, atlasJson);
  const initial =
    cycleTextures(sheet, atlasJson, selection.idle, "down") ??
    cycleTextures(sheet, atlasJson, selection.walk, "down") ??
    Object.values(sheet.textures);
  const sprite = new AnimatedSprite(initial);
  sprite.animationSpeed = FRAME_RATE / 60;
  sprite.scale.set(SCALE);
  sprite.anchor.set(0.5);
  sprite.x = VIEW.w / 2;
  sprite.y = VIEW.h / 2;
  sprite.play();
  app.stage.addChild(sprite);

  let currentKey = "";

  app.ticker.add(({ deltaTime }) => {
    const dt = deltaTime / 60;
    let vx = 0,
      vy = 0,
      dir = null;
    if (input.left) {
      vx = -SPEED;
      dir = "left";
    } else if (input.right) {
      vx = SPEED;
      dir = "right";
    }
    if (input.up) {
      vy = -SPEED;
      dir = "up";
    } else if (input.down) {
      vy = SPEED;
      dir = "down";
    }
    sprite.x = Math.max(20, Math.min(VIEW.w - 20, sprite.x + vx * dt));
    sprite.y = Math.max(20, Math.min(VIEW.h - 20, sprite.y + vy * dt));
    const moving = vx !== 0 || vy !== 0;
    const base = moving ? selection.walk : selection.idle;
    const facing = dir ?? currentKey.split("_").pop() ?? "down";
    const key = `${base}_${facing}`;
    if (key !== currentKey) {
      const textures = cycleTextures(sheet, atlasJson, base, facing);
      if (textures) {
        sprite.textures = textures;
        sprite.play();
        currentKey = key;
      }
    }
  });
}

async function fetchBytes(url) {
  try {
    const r = await fetch(url);
    const blob = await r.blob();
    return blob.size;
  } catch {
    return 0;
  }
}

async function renderStats() {
  const [pngBytes, jsonBytes, ktx2Bytes] = await Promise.all([
    fetchBytes(`${ATLAS_BASE}.png`),
    fetchBytes(`${ATLAS_BASE}.json`),
    fetchBytes(`${ATLAS_BASE}.ktx2`),
  ]);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const row = (label, bytes) =>
    `${`${label}:`.padEnd(6)}${kb(bytes).padStart(9)}`;
  document.getElementById("stats").textContent = [
    row("PNG", pngBytes),
    row("KTX2", ktx2Bytes),
    row("JSON", jsonBytes),
  ].join("\n");
}

(async () => {
  const atlasJson = await (await fetch(`${ATLAS_BASE}.json`)).json();
  populateSelectors(atlasJson);
  await Promise.all([
    bootPane("pane-png", `${ATLAS_BASE}.png`, atlasJson),
    bootPane("pane-ktx2", `${ATLAS_BASE}.ktx2`, atlasJson),
  ]);
  await renderStats();
})();
