// Atlas export — reuses the split-by-animation path to get per-frame canvases
// with full layout metadata (frameSize, direction, frame index), then trims
// each frame to its tight non-transparent bbox, deduplicates pixel-identical
// frames, and shelf-packs only the uniques into a PNG. Dedup matches are
// recorded in the JSON with a `mirrorOf` field so consumers reuse the shared
// atlas pixels.
//
// Layout comes from ANIMATION_CONFIGS + custom-animations.js, not from pixel
// heuristics.
//
// Output: a ZIP containing
//   - atlas.png  — the packed image (only unique frames)
//   - atlas.json — TexturePacker "hash" frames + `animations` (Phaser-style
//                  per-direction playback sequences).
import { ANIMATIONS, ANIMATION_CONFIGS, DIRECTIONS } from "./constants.js";
import {
  extractAnimationFromCanvas,
  SHEET_HEIGHT,
  canvas,
  addedCustomAnimations,
} from "../canvas/renderer.js";
import { customAnimations, customAnimationSize } from "../custom-animations.js";
import {
  extractFramesFromAnimation,
  extractFramesFromCustomAnimation,
  newAnimationFromSheet,
} from "../utils/zip-helpers.js";
import { canvasToBlob } from "../canvas/canvas-utils.js";
import { debugLog } from "../utils/debug.js";

// 4px gutter aligns the shelf boundaries with BasisU's 4×4 encoding blocks.
// This keeps every compressed block fully inside one frame or fully inside
// padding, preventing edge colors from bleeding across frame boundaries at
// encode time. Costs ~3-5% atlas area vs a 1px gutter.
const GUTTER = 4;
const ATLAS_VERSION = "0.1.0";

function tightBBox(frameCanvas) {
  const w = frameCanvas.width;
  const h = frameCanvas.height;
  const ctx = frameCanvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[rowOffset + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function getTrimmedPixels(frameCanvas, bbox) {
  const ctx = frameCanvas.getContext("2d", { willReadFrequently: true });
  return ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h).data;
}

// FNV-1a 32-bit. Fast, well-distributed for pixel buffers of this size.
// Collision probability at ~1000 frames with a 32-bit hash is <0.01%, so we
// don't bother with a byte-exact verification step.
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Check whether `bytes` is pixel-identical to an already-registered unique
// frame of the same dimensions. Returns the matched frame key or null. Mirror
// (flipX/flipY/rotate180) variants were measured against a default character
// and caught zero matches beyond pixel-identity, so they're not worth the
// extra passes.
function findDedup(dedupMap, bytes, w, h) {
  const entry = dedupMap.get(fnv1a(bytes));
  if (entry && entry.w === w && entry.h === h) return entry.key;
  return null;
}

function frameKey(animName, direction, frameNumber) {
  return `${animName}_${direction}_${frameNumber}`;
}

// Dedup-aware record of a frame. Unique frames go into `rects` (packed into
// atlas); deduped frames go into `mirrors` (no atlas pixels, just metadata).
function recordFrame(ctx, frameCanvas, bbox, key) {
  const { dedupMap, rects, mirrors } = ctx;
  const bytes = getTrimmedPixels(frameCanvas, bbox);
  const mirrorOf = findDedup(dedupMap, bytes, bbox.w, bbox.h);
  if (mirrorOf) {
    mirrors[key] = {
      mirrorOf,
      trimX: bbox.x,
      trimY: bbox.y,
      w: bbox.w,
      h: bbox.h,
      sourceW: frameCanvas.width,
      sourceH: frameCanvas.height,
    };
  } else {
    dedupMap.set(fnv1a(bytes), { key, w: bbox.w, h: bbox.h });
    rects.push({
      src: frameCanvas,
      sx: bbox.x,
      sy: bbox.y,
      w: bbox.w,
      h: bbox.h,
      trimX: bbox.x,
      trimY: bbox.y,
      sourceW: frameCanvas.width,
      sourceH: frameCanvas.height,
      key,
    });
  }
}

function collectStandardRects(ctx) {
  const { animations } = ctx;
  for (const anim of ANIMATIONS) {
    const animCanvas = extractAnimationFromCanvas(anim.value);
    if (!animCanvas) continue;
    const config = ANIMATION_CONFIGS[anim.value];
    const frames = extractFramesFromAnimation(
      animCanvas,
      anim.value,
      DIRECTIONS,
    );
    const directionsByFrameNumber = {};
    for (const [direction, frameList] of Object.entries(frames)) {
      directionsByFrameNumber[direction] = new Map();
      for (const { canvas: frameCanvas, frameNumber } of frameList) {
        const bbox = tightBBox(frameCanvas);
        if (!bbox) continue;
        recordFrame(
          ctx,
          frameCanvas,
          bbox,
          frameKey(anim.value, direction, frameNumber),
        );
        directionsByFrameNumber[direction].set(frameNumber, true);
      }
    }
    if (!config) continue;
    const cycle = config.cycle ?? [];
    const byDirection = {};
    for (const direction of Object.keys(directionsByFrameNumber)) {
      const present = directionsByFrameNumber[direction];
      const sequence = cycle
        .map((idx) => idx + 1)
        .filter((n) => present.has(n))
        .map((n) => frameKey(anim.value, direction, n));
      if (sequence.length > 0) byDirection[direction] = sequence;
    }
    if (Object.keys(byDirection).length > 0) {
      animations[anim.value] = {
        type: "standard",
        frameSize: 64,
        cycle: byDirection,
      };
    }
  }
}

function collectCustomRects(ctx) {
  const { animations } = ctx;
  let y = SHEET_HEIGHT;
  for (const animName of addedCustomAnimations) {
    const def = customAnimations[animName];
    if (!def) continue;
    const size = customAnimationSize(def);
    const srcRect = { x: 0, y, ...size };
    const custCanvas = newAnimationFromSheet(canvas, srcRect);
    const byDirection = {};
    if (custCanvas) {
      const frames = extractFramesFromCustomAnimation(
        custCanvas,
        def,
        DIRECTIONS,
      );
      for (const [direction, frameList] of Object.entries(frames)) {
        const sequence = [];
        for (const { canvas: frameCanvas, frameNumber } of frameList) {
          const bbox = tightBBox(frameCanvas);
          if (!bbox) continue;
          const key = frameKey(animName, direction, frameNumber);
          recordFrame(ctx, frameCanvas, bbox, key);
          sequence.push(key);
        }
        if (sequence.length > 0) byDirection[direction] = sequence;
      }
    }
    if (Object.keys(byDirection).length > 0) {
      animations[animName] = {
        type: "custom",
        frameSize: def.frameSize,
        cycle: byDirection,
      };
    }
    y += srcRect.height;
  }
}

// GPU-compressed texture formats (BC7/ASTC/ETC2) require texture dimensions
// to be multiples of their block size. Round up to the largest block size we
// care about (ASTC 4×4 → 4; ASTC 6×6/8×8 would be 6/8 but we target 4×4). If
// we later want 6×6 ASTC, bump this to 12 (LCM of supported block sizes).
const BLOCK_ALIGNMENT = 4;

function roundUp(n, multiple) {
  return Math.ceil(n / multiple) * multiple;
}

function shelfPack(rects) {
  rects.sort((a, b) => b.h - a.h || b.w - a.w);
  const totalArea = rects.reduce(
    (s, r) => s + (r.w + GUTTER) * (r.h + GUTTER),
    0,
  );
  const atlasWidth = roundUp(
    Math.max(rects[0].w + GUTTER, Math.ceil(Math.sqrt(totalArea) * 1.2)),
    BLOCK_ALIGNMENT,
  );
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = rects[0].h;
  for (const r of rects) {
    if (shelfX + r.w > atlasWidth) {
      shelfY += shelfH + GUTTER;
      shelfX = 0;
      shelfH = r.h;
    }
    r.px = shelfX;
    r.py = shelfY;
    shelfX += r.w + GUTTER;
  }
  const atlasHeight = roundUp(shelfY + shelfH, BLOCK_ALIGNMENT);
  return { atlasWidth, atlasHeight };
}

function buildJson({
  rects,
  mirrors,
  atlasWidth,
  atlasHeight,
  animations,
  imageName,
}) {
  const framesObj = {};
  const rectByKey = {};
  for (const r of rects) {
    rectByKey[r.key] = r;
    framesObj[r.key] = {
      frame: { x: r.px, y: r.py, w: r.w, h: r.h },
      trimmed: r.w !== r.sourceW || r.h !== r.sourceH,
      spriteSourceSize: { x: r.trimX, y: r.trimY, w: r.w, h: r.h },
      sourceSize: { w: r.sourceW, h: r.sourceH },
    };
  }
  // Mirror entries share the unique's atlas rect — same pixels, but each
  // keeps its own spriteSourceSize since the sprite's position within its
  // original cell can differ even when trimmed pixels match. `mirrorOf` is
  // kept as an LPC-extra hint; Phaser and TexturePacker consumers read only
  // `frame` and draw correctly.
  for (const [key, m] of Object.entries(mirrors)) {
    const shared = rectByKey[m.mirrorOf];
    framesObj[key] = {
      frame: { x: shared.px, y: shared.py, w: shared.w, h: shared.h },
      trimmed: m.w !== m.sourceW || m.h !== m.sourceH,
      spriteSourceSize: { x: m.trimX, y: m.trimY, w: m.w, h: m.h },
      sourceSize: { w: m.sourceW, h: m.sourceH },
      mirrorOf: m.mirrorOf,
    };
  }
  return {
    frames: framesObj,
    animations,
    meta: {
      app: "lpc-atlas-export",
      version: ATLAS_VERSION,
      image: imageName,
      format: "RGBA8888",
      size: { w: atlasWidth, h: atlasHeight },
      scale: "1",
    },
  };
}

async function downloadZip({ pngBlob, jsonString, ktx2Bytes, baseName }) {
  const zip = new window.JSZip();
  zip.file(`${baseName}.png`, pngBlob);
  zip.file(`${baseName}.json`, jsonString);
  if (ktx2Bytes) zip.file(`${baseName}.ktx2`, ktx2Bytes);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportAtlas() {
  if (!canvas) {
    alert("Canvas not ready.");
    return;
  }

  const ctx = {
    rects: [],
    mirrors: {},
    dedupMap: new Map(),
    animations: {},
  };
  collectStandardRects(ctx);
  collectCustomRects(ctx);

  if (ctx.rects.length === 0) {
    alert("No non-empty frames to pack.");
    return;
  }

  const { atlasWidth, atlasHeight } = shelfPack(ctx.rects);

  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasWidth;
  atlasCanvas.height = atlasHeight;
  const atlasCtx = atlasCanvas.getContext("2d");
  atlasCtx.clearRect(0, 0, atlasWidth, atlasHeight);
  for (const r of ctx.rects) {
    atlasCtx.drawImage(r.src, r.sx, r.sy, r.w, r.h, r.px, r.py, r.w, r.h);
  }

  const packedArea = ctx.rects.reduce((s, r) => s + r.w * r.h, 0);
  const density = ((100 * packedArea) / (atlasWidth * atlasHeight)).toFixed(1);
  const mirrorCount = Object.keys(ctx.mirrors).length;
  const totalFrames = ctx.rects.length + mirrorCount;
  const dedupPct =
    totalFrames > 0 ? ((100 * mirrorCount) / totalFrames).toFixed(1) : "0";
  const summary =
    `Atlas: ${atlasWidth}×${atlasHeight}px, ${density}% density\n` +
    `Frames: ${totalFrames} total → ${ctx.rects.length} unique + ${mirrorCount} deduplicated (${dedupPct}% saved)`;
  debugLog(summary);

  const baseName = "character-atlas";
  const json = buildJson({
    rects: ctx.rects,
    mirrors: ctx.mirrors,
    atlasWidth,
    atlasHeight,
    animations: ctx.animations,
    imageName: `${baseName}.png`,
  });
  const pngBlob = await canvasToBlob(atlasCanvas);

  // KTX2 encode is lazy so the 2.7 MB WASM only loads when you click export.
  let ktx2Bytes = null;
  let ktx2Summary = "";
  try {
    const { encodeKtx2 } = await import("./atlas-ktx.js");
    const result = await encodeKtx2(atlasCanvas);
    ktx2Bytes = result.bytes;
    ktx2Summary = `\nKTX2 (UASTC + zstd): ${(ktx2Bytes.byteLength / 1024).toFixed(1)} KB, encoded in ${result.elapsedMs.toFixed(0)} ms`;
  } catch (err) {
    ktx2Summary = `\nKTX2 encode failed: ${err.message}`;
    debugLog("KTX2 encode error:", err);
  }

  await downloadZip({
    pngBlob,
    jsonString: JSON.stringify(json, null, 2),
    ktx2Bytes,
    baseName,
  });
  alert(summary + ktx2Summary);
}
