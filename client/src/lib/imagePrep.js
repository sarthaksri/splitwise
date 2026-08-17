/**
 * Getting a phone photo ready to be read.
 *
 * Two things have to happen before a bill can be uploaded:
 *
 *   Rotate it. Phones store a portrait shot as landscape pixels plus an EXIF
 *   orientation flag. Drawing that to a canvas naively gives a sideways image,
 *   and OCR on sideways text returns nothing at all.
 *
 *   Shrink it. A 12-megapixel original takes far longer to recognise without
 *   being any more legible. 2200px on the long edge keeps the small print of a
 *   thermal receipt sharp while cutting the work substantially.
 *
 * The result is handed to Tesseract on the device and never uploaded, so this
 * is about recognition speed and accuracy, not bandwidth.
 */

/** Refuse obviously wrong files before doing any work on them. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export class ImagePrepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImagePrepError';
  }
}

/**
 * @param {File|Blob} file
 * @param {{maxEdge?: number, quality?: number}} [options]
 * @returns {Promise<Blob>} upright, downscaled, ready for OCR
 */
export async function prepareImage(file, { maxEdge = 2200, quality = 0.9 } = {}) {
  if (!file) throw new ImagePrepError('Pick a photo of the bill first.');
  if (!String(file.type || '').startsWith('image/')) {
    throw new ImagePrepError('That is not an image. Take a photo of the bill, or pick one.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImagePrepError('That photo is enormous. Try one taken at a normal resolution.');
  }

  let bitmap;
  try {
    // `from-image` is what applies the EXIF rotation.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImagePrepError("Couldn't open that image. Try a JPEG or PNG.");
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // Receipts are thin dark text on white; smoothing the downscale keeps strokes
  // continuous instead of dropping them to nothing.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // A white ground, so a PNG with transparency doesn't become black-on-black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new ImagePrepError("Couldn't process that photo. Try another one.");
  return blob;
}
