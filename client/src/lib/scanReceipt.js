/**
 * Reading a bill, by whichever engine is available.
 *
 * The server is asked first. If it has a Gemini key it does the work and
 * returns structured dishes. If it doesn't — or the call failed upstream — it
 * says `fallback: 'tesseract'` and we do it here in the browser instead.
 *
 * That ordering is deliberate. Gemini is markedly better at a crumpled photo of
 * a thermal bill, but Tesseract needs no key, no account and no network, so
 * anyone who clones this repo gets a working scanner out of the box.
 */

import { api } from '../api/client.js';
import { normalizeScan, parseReceiptText, reconcileScan } from '@shared/receipt.js';
import { prepareImage } from './imagePrep.js';

/**
 * Run OCR in the browser.
 *
 * Imported dynamically: tesseract.js pulls several megabytes of WASM and
 * language data, and most sessions never scan anything. A static import would
 * make every user pay for it on first load.
 */
async function withTesseract(blob, onProgress) {
  const { default: Tesseract } = await import('tesseract.js');
  const { data } = await Tesseract.recognize(blob, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(0.4 + m.progress * 0.6);
    },
  });
  return data.text;
}

/**
 * @param {File|Blob} file the photo
 * @param {{onProgress?: (fraction: number) => void, onEngine?: (name: string) => void}} [hooks]
 * @returns {Promise<{scan: object, reconcile: object, provider: string}>}
 */
export async function scanReceipt(file, { onProgress, onEngine } = {}) {
  onProgress?.(0.05);
  const { imageBase64, mimeType } = await prepareImage(file);
  onProgress?.(0.2);

  let result = null;
  try {
    result = await api.post('/expenses/scan', { imageBase64, mimeType });
  } catch (err) {
    // A 422 means the server read the photo and genuinely found no dishes on
    // it. Retrying locally with a weaker engine would only waste the user's
    // time to reach the same answer, so that one is passed straight through.
    if (err.status === 422) throw err;
    // Anything else — offline, rate limited, a 500 — is worth trying locally.
    result = { fallback: 'tesseract' };
  }

  if (result?.provider === 'gemini') {
    onEngine?.('gemini');
    onProgress?.(1);
    return { ...result, provider: 'gemini' };
  }

  onEngine?.('tesseract');
  onProgress?.(0.35);
  const text = await withTesseract(file, onProgress);
  const scan = normalizeScan(parseReceiptText(text));
  onProgress?.(1);
  return { scan, reconcile: reconcileScan(scan), provider: 'tesseract' };
}
