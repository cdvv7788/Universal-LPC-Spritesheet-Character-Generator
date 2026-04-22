// Minimal Phaser scene that loads an LPC atlas (PNG + TexturePacker-hash JSON)
// exported from this repo's "Atlas (ZIP: PNG + JSON)" button. Registers every
// animation key from the JSON's `animations` dict, then lets you walk a
// character around with the arrow keys.
const ATLAS_BASE = "character-atlas";
const VIEW = { w: 400, h: 300 };
const SPEED = 80; // px/sec

let player;
let cursors;
let currentAnim = "";
let idleBase = "idle";
let walkBase = "walk";

function preload() {
  this.load.atlas("char", `${ATLAS_BASE}.png`, `${ATLAS_BASE}.json`);
  this.load.json("atlasMeta", `${ATLAS_BASE}.json`);
}

function registerAnimations(scene, atlasJson) {
  // animations: { <animName>: { type, frameSize, cycle: { <direction>: [names] } } }
  for (const [animName, entry] of Object.entries(atlasJson.animations ?? {})) {
    for (const [direction, sequence] of Object.entries(entry.cycle ?? {})) {
      const key = `${animName}_${direction}`;
      if (scene.anims.exists(key)) continue;
      scene.anims.create({
        key,
        frames: sequence.map((f) => ({ key: "char", frame: f })),
        frameRate: 8,
        repeat: -1,
      });
    }
  }
}

function populateAnimSelectors(atlasJson) {
  const bases = Object.keys(atlasJson.animations ?? {});
  const idleSelect = document.getElementById("idle-select");
  const walkSelect = document.getElementById("walk-select");
  for (const base of bases) {
    idleSelect.add(new Option(base, base));
    walkSelect.add(new Option(base, base));
  }
  if (bases.includes("idle")) idleSelect.value = "idle";
  if (bases.includes("walk")) walkSelect.value = "walk";
  idleBase = idleSelect.value || bases[0];
  walkBase = walkSelect.value || bases[0];
  idleSelect.addEventListener("change", () => {
    idleBase = idleSelect.value;
  });
  walkSelect.addEventListener("change", () => {
    walkBase = walkSelect.value;
  });
}

function showStats(atlasJson) {
  const framesDict = atlasJson.frames ?? {};
  const total = Object.keys(framesDict).length;
  const mirrored = Object.values(framesDict).filter((f) => f.mirrorOf).length;
  const unique = total - mirrored;
  const pct = total > 0 ? ((100 * mirrored) / total).toFixed(1) : "0";
  const size = atlasJson.meta?.size;
  document.getElementById("stats").textContent =
    `Atlas ${size?.w}×${size?.h}px · ${total} frames (${unique} unique + ${mirrored} dedup, ${pct}% saved)`;
}

function create() {
  const atlasJson = this.cache.json.get("atlasMeta");
  registerAnimations(this, atlasJson);
  populateAnimSelectors(atlasJson);
  showStats(atlasJson);

  player = this.add.sprite(VIEW.w / 2, VIEW.h / 2, "char");
  player.setScale(2);
  cursors = this.input.keyboard.createCursorKeys();
  playIfExists.call(this, `${idleBase}_down`);
}

function playIfExists(key) {
  if (!this.anims.exists(key)) return;
  if (currentAnim === key) return;
  player.play(key);
  currentAnim = key;
}

function update(_, deltaMs) {
  const dt = deltaMs / 1000;
  let vx = 0;
  let vy = 0;
  let dir = null;
  if (cursors.left.isDown) {
    vx = -SPEED;
    dir = "left";
  } else if (cursors.right.isDown) {
    vx = SPEED;
    dir = "right";
  }
  if (cursors.up.isDown) {
    vy = -SPEED;
    dir = "up";
  } else if (cursors.down.isDown) {
    vy = SPEED;
    dir = "down";
  }
  player.x = Phaser.Math.Clamp(player.x + vx * dt, 20, VIEW.w - 20);
  player.y = Phaser.Math.Clamp(player.y + vy * dt, 20, VIEW.h - 20);
  const moving = vx !== 0 || vy !== 0;
  const base = moving ? walkBase : idleBase;
  const facing = dir ?? currentAnim.split("_").pop() ?? "down";
  playIfExists.call(this, `${base}_${facing}`);
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: VIEW.w,
  height: VIEW.h,
  pixelArt: true,
  backgroundColor: "#111",
  scene: { preload, create, update },
});
