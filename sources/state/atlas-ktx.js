// BasisU/KTX2 encoder integration for the atlas export. Loads the BasisU
// encoder WebAssembly lazily (first export-button click pays the ~3 MB cost,
// subsequent encodes hit the browser cache) and wraps the Embind API in a
// single `encodeKtx2(canvas)` function.
//
// WASM/JS blobs live under `public/vendor/basis/` and are served as-is in
// dev via the DynamicPublicDirectory plugin in vite/get-spritesheets-plugin.js.
// For production builds, they'll need to be copied into `dist/` alongside
// `spritesheets/` (TODO if we ship this path).
//
// Source: https://github.com/BinomialLLC/basis_universal (Apache 2.0).

const BASIS_BASE = "/vendor/basis";
const BASIS_JS = `${BASIS_BASE}/basis_encoder.js`;
const BASIS_WASM = "basis_encoder.wasm";

let basisModulePromise = null;

function loadBasisScript() {
  if (window.BASIS) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = BASIS_JS;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${BASIS_JS}`));
    document.head.appendChild(s);
  });
}

async function getBasisModule() {
  if (basisModulePromise) return basisModulePromise;
  basisModulePromise = (async () => {
    await loadBasisScript();
    const Module = await window.BASIS({
      locateFile: (path) =>
        path === BASIS_WASM ? `${BASIS_BASE}/${BASIS_WASM}` : path,
    });
    Module.initializeBasis();
    return Module;
  })();
  return basisModulePromise;
}

/**
 * Encode an RGBA canvas to a .ktx2 byte array (UASTC + zstd supercompression).
 * Khronos standard container; consumed by three.js, Babylon, Godot, Unity,
 * and PixiJS via the `loadKTX2` extension.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<{bytes: Uint8Array, elapsedMs: number}>}
 */
export async function encodeKtx2(canvas) {
  const Module = await getBasisModule();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const encoder = new Module.BasisEncoder();
  try {
    encoder.setSliceSourceImage(0, rgba, width, height, 0);
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true); // zstd outer layer
    encoder.setFormatMode(Module.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(true);
    encoder.setKTX2AndBasisSRGBTransferFunc(true);
    encoder.setMipSRGB(true);
    encoder.setYFlip(false);
    encoder.setMipGen(false);
    encoder.setPackUASTCFlags(3);
    encoder.setDebug(false);
    encoder.setComputeStats(false);

    const outputBuffer = new Uint8Array(width * height * 4);
    const t0 = performance.now();
    const numBytes = encoder.encode(outputBuffer);
    const elapsedMs = performance.now() - t0;
    if (numBytes === 0) {
      throw new Error("BasisEncoder.encode() returned 0 bytes");
    }
    return {
      bytes: new Uint8Array(outputBuffer.buffer, 0, numBytes).slice(),
      elapsedMs,
    };
  } finally {
    encoder.delete();
  }
}
