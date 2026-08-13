/**
 * Getting a phone photo ready to be read.
 *
 * Two things have to happen before a bill can be uploaded:
 *
 *   Rotate it. Phones store a portrait shot as landscape pixels plus an EXIF
 *   orientation flag. Drawing that to a canvas naively gives a sideways image,
 *   and OCR on sideways text returns nothing at all.
 *
 *   Shrink it. A modern phone camera produces 4–12MB, well past Vercel's 4.5MB
 *   request cap. 1600px on the long edge is plenty — receipt text stays legible
 *   and the upload drops to a few hundred KB, which also makes it quick on a
 *   restaurant's patchy signal.
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
 * @returns {Promise<{imageBase64: string, mimeType: string, bytes: number}>}
 */
export async function prepareImage(file, { maxEdge = 1600, quality = 0.8 } = {}) {
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

  return {
    imageBase64: await blobToBase64(blob),
    mimeType: 'image/jpeg',
    bytes: blob.size,
  };
}

/** The bare base64, with the `data:` prefix stripped — the API wants only the payload. */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ImagePrepError("Couldn't read that photo."));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
