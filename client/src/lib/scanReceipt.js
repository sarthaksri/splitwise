/**
 * Reading a bill: OCR here, sense-making there.
 *
 * The photo is recognised on the device with Tesseract, and only the resulting
 * text is sent to the server, where Gemini turns it into dishes, quantities and
 * taxes. If there's no key — or Gemini is unavailable — the same text is parsed
 * locally by the heuristics in `shared/receipt.js` and the app still works.
 *
 * Splitting it this way matters:
 *
 *   The photograph never leaves the phone. A bill carries card digits and a
 *   record of where somebody was on a Friday night, and none of that is needed
 *   to work out who owes what.
 *
 *   Text requests actually succeed. Google's free tier is routinely saturated
 *   for images — measured 503s took between 18 and 306 seconds — while text
 *   answers in under two.
 *
 *   A few hundred tokens instead of a few thousand, so a small free allowance
 *   stretches much further.
 *
 *   Layout stops being my problem. Bills differ wildly, and a language model
 *   reading collapsed OCR columns handles shapes no regex of mine anticipated.
 */

import { api } from '../api/client.js';
import { normalizeScan, parseReceiptText, reconcileScan } from '@shared/receipt.js';
import { prepareImage } from './imagePrep.js';

/**
 * Recognise the photo.
 *
 * tesseract.js is imported dynamically: it pulls several megabytes of WASM and
 * language data, and most sessions never scan anything, so a static import
 * would make every visitor pay for it on first load.
 */
async function readText(blob, onProgress) {
  const { default: Tesseract } = await import('tesseract.js');
  const { data } = await Tesseract.recognize(blob, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(0.15 + m.progress * 0.6);
    },
  });
  return data.text ?? '';
}

/**
 * @param {File|Blob} file the photo
 * @param {{onProgress?: (fraction: number) => void, onStage?: (stage: string) => void}} [hooks]
 * @returns {Promise<{scan: object, reconcile: object, provider: string, reason?: string}>}
 */
export async function scanReceipt(file, { onProgress, onStage } = {}) {
  onStage?.('reading');
  onProgress?.(0.05);

  // Rotated upright and scaled down — OCR reads a sideways bill as nothing, and
  // a 12-megapixel original is slow without being any more legible.
  const image = await prepareImage(file);
  const text = await readText(image, onProgress);

  if (text.trim().length < 8) {
    throw new Error(
      "Couldn't read any text on that photo. Try again with more light, or hold the bill flat.",
    );
  }

  onStage?.('structuring');
  onProgress?.(0.8);

  let result = null;
  try {
    result = await api.post('/expenses/scan', { text });
  } catch (err) {
    // A 422 means the text was read and genuinely has no food on it. The local
    // parser works from the same characters and would agree, so don't waste the
    // user's time reaching the same answer twice.
    if (err.status === 422) throw err;
    result = { fallback: 'local' };
  }

  if (result?.provider === 'gemini') {
    onProgress?.(1);
    return { ...result, provider: 'gemini' };
  }

  onStage?.('local');
  const scan = normalizeScan(parseReceiptText(text));
  onProgress?.(1);
  return {
    scan,
    reconcile: reconcileScan(scan),
    provider: 'local',
    // 'no-key' is just how this deployment is set up; 'upstream' and 'quota'
    // are temporary and worth saying, or a rougher result looks like the best
    // the app can do.
    reason: result?.reason ?? 'upstream',
  };
}
