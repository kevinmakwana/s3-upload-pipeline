import { Jimp } from 'jimp';

export const THUMBNAIL_SIZE = 256;
/** Image formats Jimp can decode without native dependencies. */
export const THUMBNAILABLE = new Set(['image/png', 'image/jpeg', 'image/gif']);

export interface ThumbnailResult {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Decodes an image, reads its dimensions, and renders a JPEG thumbnail. */
export async function makeThumbnail(data: Buffer): Promise<ThumbnailResult> {
  const image = await Jimp.read(data);
  const { width, height } = image;
  image.scaleToFit({ w: THUMBNAIL_SIZE, h: THUMBNAIL_SIZE });
  const jpeg = await image.getBuffer('image/jpeg', { quality: 80 });
  return { jpeg, width, height };
}
