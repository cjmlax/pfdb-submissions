import sharp from 'sharp';
import { config } from './config';
import { putObject } from './storage';
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

// Stores an uploaded screenshot for submission `id` and returns its key, plus
// the key of the kept original when it was auto-cropped. With `autoCrop`, a
// recognized breeding screen is cropped/masked/resized; anything unrecognized
// is stored as-is (compressed) for the admin to crop by hand.
export async function storeScreenshot(
  id: string,
  input: Buffer,
  opts: { autoCrop: boolean },
): Promise<{ screenshot: string; original: string | null }> {
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
    const originalKey = originalScreenshotName(id);
    await putObject(originalKey, original.data);
    await putObject(screenshot, cropped);
    return { screenshot, original: originalKey };
  }
  await putObject(screenshot, original.data);
  return { screenshot, original: null };
}
