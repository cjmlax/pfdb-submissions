import sharp from 'sharp';
import { config } from './config';

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
    .webp({ quality: config.image.quality })
    .toBuffer();
  return { data, ext: 'webp' };
}
