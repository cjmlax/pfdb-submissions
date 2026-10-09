import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config';
import { uploadsDir } from './db';
import { autoCropBreedScreenshot } from './screenshotAutoCrop';

export async function compressImage(input: Buffer): Promise<{ data: Buffer; ext: 'webp' }> {
  const data = await sharp(input)
    .webp({ quality: config.image.quality })
    .toBuffer();
  return { data, ext: 'webp' };
}

export async function cropImage(
  input: Buffer,
  crop: { left: number; top: number; right: number; bottom: number },
): Promise<{ data: Buffer; ext: 'webp' }> {
  const { width = 0, height = 0 } = await sharp(input).metadata();
  const left   = Math.round(width  * crop.left);
  const top    = Math.round(height * crop.top);
  const cWidth = Math.round(width  * (crop.right  - crop.left));
  const cHeight= Math.round(height * (crop.bottom - crop.top));
  const data = await sharp(input)
    .extract({ left, top, width: cWidth, height: cHeight })
    .resize({ width: config.image.screenshotWidth, withoutEnlargement: true })
    .webp({ quality: config.image.quality })
    .toBuffer();
  return { data, ext: 'webp' };
}

// While a submission is pending, an auto-cropped screenshot keeps the
// uncropped upload alongside it so the admin can re-crop from scratch if the
// auto-crop got it wrong. Dropped once the row is approved or discarded.
export function originalScreenshotName(id: string): string {
  return `${id}.orig.webp`;
}

export function removeOriginalScreenshot(id: string): void {
  const p = path.join(uploadsDir, originalScreenshotName(id));
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Stores an uploaded screenshot for submission `id` and returns its filename.
// With `autoCrop`, a recognized breeding screen is cropped/masked/resized and
// the original kept for re-cropping; anything unrecognized is stored as-is
// (compressed) for the admin to crop by hand.
export async function storeScreenshot(
  id: string,
  input: Buffer,
  opts: { autoCrop: boolean },
): Promise<{ screenshot: string; autoCropped: boolean }> {
  removeOriginalScreenshot(id);
  const original = await compressImage(input);
  const screenshot = `${id}.${original.ext}`;

  let cropped: Buffer | null = null;
  if (opts.autoCrop) {
    try {
      cropped = (await autoCropBreedScreenshot(input, {
        width: config.image.screenshotWidth,
        quality: config.image.quality,
      }))?.data ?? null;
    } catch {
      cropped = null;
    }
  }

  if (cropped) {
    fs.writeFileSync(path.join(uploadsDir, originalScreenshotName(id)), original.data);
    fs.writeFileSync(path.join(uploadsDir, screenshot), cropped);
  } else {
    fs.writeFileSync(path.join(uploadsDir, screenshot), original.data);
  }
  return { screenshot, autoCropped: !!cropped };
}
