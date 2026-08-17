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
import { MAX_PAGES, normalizeScan, parseReceiptPages, reconcileScan } from '@shared/receipt.js';
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
    // 0 to 1 for this photo alone; the caller places it in the overall bar.
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  return data.text ?? '';
}

/** OCR that produced fewer characters than this saw nothing worth having. */
const MIN_TEXT = 8;

/**
 * Read a bill and turn it into dish rows.
 *
 * A bill is often more than one photograph. A long thermal receipt is
 * unreadable in a single shot from far enough away to fit it all in, so people
 * take it in overlapping pieces — and a phone's camera hands them over one at a
 * time, which is why `alreadyRead` exists: the text of the photos already
 * recognised comes back in, and only the new ones are read again. Tesseract
 * costs seconds per photo, and re-reading page one to add page two would make
 * the second photo feel like a punishment.
 *
 * All the pages are then structured together, in one request. Deciding where
 * one photo overlaps the next, and which of two readings of the same line to
 * believe, is a judgement about the whole bill — it can't be made a page at a
 * time.
 *
 * @param {File[]|File} input the new photo(s), in the order they were taken
 * @param {object} [options]
 * @param {string[]} [options.alreadyRead] OCR text of photos read on an earlier
 *   pass, which are kept in front of the new ones
 * @param {(fraction: number) => void} [options.onProgress]
 * @param {(stage: string) => void} [options.onStage]
 * @param {(page: {index: number, total: number}) => void} [options.onPage]
 *   which photo is being read, for a "photo 2 of 3" label
 * @returns {Promise<{scan: object, reconcile: object, provider: string,
 *   reason?: string, pages: string[], unreadable: number}>}
 */
export async function scanReceipt(
  input,
  { alreadyRead = [], onProgress, onStage, onPage } = {},
) {
  const files = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (files.length === 0) throw new Error('Pick a photo of the bill first.');

  const room = MAX_PAGES - alreadyRead.length;
  if (room <= 0) {
    throw new Error(`That's ${MAX_PAGES} photos already — as much bill as this can read at once.`);
  }

  onStage?.('reading');
  onProgress?.(0.05);

  const fresh = [];
  let unreadable = 0;
  const queue = files.slice(0, room);

  for (const [index, file] of queue.entries()) {
    onPage?.({ index: alreadyRead.length + index, total: alreadyRead.length + queue.length });

    // Rotated upright and scaled down — OCR reads a sideways bill as nothing,
    // and a 12-megapixel original is slow without being any more legible.
    const image = await prepareImage(file);
    // Each photo gets its own slice of the reading band, so the bar advances
    // steadily across all of them instead of restarting at every photo.
    const text = await readText(image, (fraction) =>
      onProgress?.(0.05 + ((index + fraction) / queue.length) * 0.7),
    );

    if (text.trim().length < MIN_TEXT) unreadable += 1;
    else fresh.push(text);
  }

  const pages = [...alreadyRead, ...fresh];

  if (pages.length === 0) {
    throw new Error(
      files.length > 1
        ? "Couldn't read any text on those photos. Try again with more light, or hold the bill flat."
        : "Couldn't read any text on that photo. Try again with more light, or hold the bill flat.",
    );
  }

  onStage?.('structuring');
  onProgress?.(0.8);

  let result = null;
  try {
    result = await api.post('/expenses/scan', { pages });
  } catch (err) {
    // A 422 means the text was read and genuinely has no food on it. The local
    // parser works from the same characters and would agree, so don't waste the
    // user's time reaching the same answer twice.
    if (err.status === 422) throw err;
    result = { fallback: 'local' };
  }

  if (result?.provider === 'gemini') {
    onProgress?.(1);
    return { ...result, provider: 'gemini', pages, unreadable };
  }

  onStage?.('local');
  const scan = normalizeScan(parseReceiptPages(pages));
  onProgress?.(1);
  return {
    scan,
    reconcile: reconcileScan(scan),
    provider: 'local',
    // 'no-key' is just how this deployment is set up; 'upstream' and 'quota'
    // are temporary and worth saying, or a rougher result looks like the best
    // the app can do.
    reason: result?.reason ?? 'upstream',
    pages,
    unreadable,
  };
}
