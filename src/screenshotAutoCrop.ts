import sharp from 'sharp';

// Auto-crops a Pocket Frogs breeding-screen screenshot down to the "Possible
// offspring" box plus the parent dish above it, blacks out everything else
// (other UI that shows through on some aspect ratios), and normalizes the width.
//
// Detection is purely geometric off the game's fixed palette, so it's
// resolution-independent:
//   1. The box interior is the largest tan region on screen.
//   2. Its brown frame is found by scanning outward from the tan to the black
//      background (left/right at mid-height, bottom/top near the left/right
//      edges — clear of the selection panel that butts against the bottom).
//   3. The parent dish is fit as a circle from its left/right silhouette edges
//      in the rows above the box.
// Every measurement is sanity-checked against the box's own size; any doubt
// returns null so the caller can fall back to the untouched screenshot.

type Rgb = Uint8Array | Buffer;

interface Raw { data: Rgb; width: number; height: number; }

export interface AutoCropGeometry {
  box: { left: number; top: number; right: number; bottom: number; radius: number };
  dish: { cx: number; cy: number; r: number };
  crop: { left: number; top: number; width: number; height: number };
}

// Background black (incl. anti-aliased frame edges fading into it).
function isDark(d: Rgb, i: number): boolean {
  return d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40;
}

// The parchment-coloured box interior, top-to-bottom gradient included.
function isTan(d: Rgb, i: number): boolean {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return r > 140 && g > 105 && b > 50 && r >= g && g > b && r - b > 60 && r - g < 50;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Bounding box of the largest 4-connected tan blob, on a coarse grid.
function findTanBlob(img: Raw): { left: number; top: number; right: number; bottom: number } | null {
  const { data, width: W, height: H } = img;
  const step = Math.max(1, Math.round(W / 270));
  const gw = Math.floor(W / step), gh = Math.floor(H / step);
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * step + (step >> 1), y = gy * step + (step >> 1);
      if (isTan(data, (y * W + x) * 3)) grid[gy * gw + gx] = 1;
    }
  }

  let best: { n: number; l: number; t: number; r: number; b: number } | null = null;
  const stack: number[] = [];
  for (let start = 0; start < grid.length; start++) {
    if (grid[start] !== 1) continue;
    grid[start] = 2;
    stack.push(start);
    let n = 0, l = gw, t = gh, r = 0, b = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % gw, y = (p - x) / gw;
      n++;
      if (x < l) l = x; if (x > r) r = x;
      if (y < t) t = y; if (y > b) b = y;
      if (x > 0      && grid[p - 1]  === 1) { grid[p - 1]  = 2; stack.push(p - 1); }
      if (x < gw - 1 && grid[p + 1]  === 1) { grid[p + 1]  = 2; stack.push(p + 1); }
      if (y > 0      && grid[p - gw] === 1) { grid[p - gw] = 2; stack.push(p - gw); }
      if (y < gh - 1 && grid[p + gw] === 1) { grid[p + gw] = 2; stack.push(p + gw); }
    }
    if (!best || n > best.n) best = { n, l, t, r, b };
  }
  if (!best) return null;
  return { left: best.l * step, top: best.t * step, right: (best.r + 1) * step - 1, bottom: (best.b + 1) * step - 1 };
}

// Walks from (x, y) by (dx, dy) until `run` consecutive dark pixels, returning
// the last non-dark position along the axis — or null if it runs off-image.
function scanToDark(img: Raw, x: number, y: number, dx: number, dy: number, run: number): number | null {
  const { data, width: W, height: H } = img;
  let last = dx ? x : y, dark = 0;
  while (x >= 0 && x < W && y >= 0 && y < H) {
    if (isDark(data, (y * W + x) * 3)) {
      if (++dark >= run) return last;
    } else {
      dark = 0;
      last = dx ? x : y;
    }
    x += dx; y += dy;
  }
  return null;
}

// Least-squares (Kasa) circle fit.
function fitCircle(pts: Array<[number, number]>): { cx: number; cy: number; r: number } | null {
  if (pts.length < 6) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
  }
  const n = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c]' = [sxz syz sz]'
  const m = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-9) return null;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
    }
  }
  const a = m[0][3] / m[0][0], b = m[1][3] / m[1][1], c = m[2][3] / m[2][2];
  const cx = a / 2, cy = b / 2;
  const r2 = c + cx * cx + cy * cy;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}

export function detectBreedLayout(img: Raw): AutoCropGeometry | null {
  const { data, width: W, height: H } = img;
  const blob = findTanBlob(img);
  if (!blob) return null;
  const blobW = blob.right - blob.left, blobH = blob.bottom - blob.top;
  if (blobW < W * 0.35 || blobW / blobH < 1.3 || blobW / blobH > 3.5) return null;

  const darkRun = Math.max(3, Math.round(blobW * 0.006));

  // Left/right: across the middle band of the interior, tan edge → frame → black.
  const innerL: number[] = [], innerR: number[] = [], outerL: number[] = [], outerR: number[] = [];
  for (let k = 0; k < 9; k++) {
    const y = Math.round(blob.top + blobH * (0.4 + k * 0.05));
    let x = Math.max(0, blob.left - 4);
    while (x < blob.right && !isTan(data, (y * W + x) * 3)) x++;
    let xr = Math.min(W - 1, blob.right + 4);
    while (xr > blob.left && !isTan(data, (y * W + xr) * 3)) xr--;
    const ol = scanToDark(img, x, y, -1, 0, darkRun);
    const or = scanToDark(img, xr, y, 1, 0, darkRun);
    if (ol === null || or === null) continue;
    innerL.push(x); innerR.push(xr); outerL.push(ol); outerR.push(or);
  }
  if (outerL.length < 5) return null;
  const left = median(outerL), right = median(outerR);
  const frameL = median(innerL) - left, frameR = right - median(innerR);
  const boxW = right - left;
  if (frameL < boxW * 0.005 || frameR < boxW * 0.005) return null;
  if (frameL > boxW * 0.08 || frameR > boxW * 0.08) return null;
  if (Math.abs(frameL - frameR) > Math.max(frameL, frameR) * 0.5 + 2) return null;
  const frame = (frameL + frameR) / 2;

  // Top/bottom: columns just inside each side, outboard of the selection panel
  // that sits flush under the box and of the header text.
  const bottoms: number[] = [], tops: number[] = [];
  for (const f of [0.045, 0.055, 0.065, 0.935, 0.945, 0.955]) {
    const x = Math.round(left + boxW * f);
    let y = Math.round(blob.top + blobH * 0.5);
    while (y < H - 1 && isTan(data, (y * W + x) * 3)) y++;
    const b = scanToDark(img, x, y, 0, 1, darkRun);
    if (b !== null) bottoms.push(b);
    const t = scanToDark(img, x, blob.top, 0, -1, darkRun);
    if (t !== null) tops.push(t);
  }
  if (bottoms.length < 3 || tops.length < 3) return null;
  const bottom = Math.max(...bottoms.sort((a, b) => a - b).slice(0, Math.ceil(bottoms.length / 2) + 1));
  const top = median(tops);
  if (bottom - blob.bottom > frame * 4 + darkRun || bottom - blob.bottom < frame * 0.4) return null;
  const header = blob.top - top;
  if (header < 1 || header > boxW * 0.25) return null;

  // Rounded-corner radius from how far each bottom corner's diagonal travels
  // through background before meeting the frame: d = r(1 − 1/√2).
  const radii: number[] = [];
  for (const [cx0, cy0, sx, sy] of [[left, bottom, 1, -1], [right, bottom, -1, -1], [left, top, 1, 1], [right, top, -1, 1]]) {
    let d = 0;
    while (d < boxW * 0.05 && isDark(data, ((cy0 + sy * d) * W + (cx0 + sx * d)) * 3)) d++;
    if (d > 0 && d < boxW * 0.05) radii.push(d / (1 - Math.SQRT1_2));
  }
  const radius = radii.length >= 2 ? Math.min(median(radii), boxW * 0.1) : boxW * 0.045;

  // Parent dish: silhouette edges scanned inward from either side of centre,
  // row by row upward from the box top until the dish ends.
  const mid = Math.round((left + right) / 2);
  const reach = Math.round(boxW * 0.35);
  const pts: Array<[number, number]> = [];
  let dishTopSeen = top;
  for (let y = Math.round(top) - 2; y > top - boxW * 0.5 && y >= 0; y--) {
    const row = y * W * 3;
    const xl0 = Math.max(0, mid - reach), xr0 = Math.min(W - 1, mid + reach);
    let xl = -1, xr = -1;
    if (isDark(data, row + xl0 * 3)) for (let x = xl0; x <= mid; x++) if (!isDark(data, row + x * 3)) { xl = x; break; }
    if (isDark(data, row + xr0 * 3)) for (let x = xr0; x >= mid; x--) if (!isDark(data, row + x * 3)) { xr = x; break; }
    if (xl < 0 && xr < 0) {
      // Both scans hit centre without meeting anything: past the dish top
      // (allow a few rows of slack for anti-aliasing).
      if (dishTopSeen - y > darkRun * 2) break;
      continue;
    }
    dishTopSeen = y;
    if (xl >= 0) pts.push([xl, y]);
    if (xr >= 0) pts.push([xr, y]);
  }
  let dish = fitCircle(pts);
  if (!dish) return null;
  // One outlier-rejection pass (frog feet poking past the rim, stray UI).
  const resid = pts.map(([x, y]) => Math.abs(Math.hypot(x - dish!.cx, y - dish!.cy) - dish!.r));
  const cut = Math.max(2, median(resid) * 3);
  dish = fitCircle(pts.filter((_, i) => resid[i] <= cut)) ?? dish;
  if (dish.r < boxW * 0.12 || dish.r > boxW * 0.35) return null;
  if (Math.abs(dish.cx - mid) > boxW * 0.05) return null;
  if (dish.cy - dish.r > top - boxW * 0.05) return null; // dish must poke above the box

  const margin = Math.round(boxW * 0.015);
  const cl = Math.max(0, Math.floor(left - margin));
  const ct = Math.max(0, Math.floor(Math.min(dish.cy - dish.r, top) - margin));
  const cr = Math.min(W, Math.ceil(right + margin + 1));
  const cb = Math.min(H, Math.ceil(bottom + margin + 1));

  return {
    box: { left, top, right, bottom, radius },
    dish,
    crop: { left: cl, top: ct, width: cr - cl, height: cb - ct },
  };
}

// Zeroes every pixel outside the rounded box ∪ dish, with a 1px soft edge.
function maskOutside(img: Raw, g: AutoCropGeometry): void {
  const { data, width: W, height: H } = img;
  const ox = g.crop.left, oy = g.crop.top;
  const { left, top, right, bottom, radius: rr } = g.box;
  const pad = 1.5; // keep the frame's anti-aliased outer edge
  const dr = g.dish.r + pad + 1;
  for (let y = 0; y < H; y++) {
    const py = y + oy + 0.5;
    for (let x = 0; x < W; x++) {
      const px = x + ox + 0.5;
      // Signed distance outside the rounded rectangle.
      const qx = Math.max(left - pad + rr - px, px - (right + pad - rr), 0);
      const qy = Math.max(top - pad + rr - py, py - (bottom + pad - rr), 0);
      const inRectBand = px >= left - pad && px <= right + pad && py >= top - pad && py <= bottom + pad;
      const boxOut = inRectBand ? Math.hypot(qx, qy) - rr : Infinity;
      const dishOut = Math.hypot(px - g.dish.cx, py - g.dish.cy) - dr;
      const out = Math.min(boxOut, dishOut);
      if (out <= 0) continue;
      const i = (y * W + x) * 3;
      if (out >= 1) { data[i] = data[i + 1] = data[i + 2] = 0; continue; }
      const k = 1 - out;
      data[i] *= k; data[i + 1] *= k; data[i + 2] *= k;
    }
  }
}

export interface AutoCropOptions {
  width: number;   // output width; narrower crops aren't upscaled
  quality: number; // webp quality
}

// Returns the cropped, masked, resized webp — or null when the screenshot
// doesn't look like a breeding screen with confidence.
export async function autoCropBreedScreenshot(
  input: Buffer,
  opts: AutoCropOptions,
): Promise<{ data: Buffer; ext: 'webp'; geometry: AutoCropGeometry } | null> {
  const { data, info } = await sharp(input).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const full: Raw = { data, width: info.width, height: info.height };

  let geometry: AutoCropGeometry | null;
  try {
    geometry = detectBreedLayout(full);
  } catch {
    geometry = null;
  }
  if (!geometry) return null;

  const { left, top, width, height } = geometry.crop;
  const cropped = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer();
  maskOutside({ data: cropped, width, height }, geometry);

  const out = await sharp(cropped, { raw: { width, height, channels: 3 } })
    .resize({ width: opts.width, withoutEnlargement: true })
    .webp({ quality: opts.quality })
    .toBuffer();
  return { data: out, ext: 'webp', geometry };
}
