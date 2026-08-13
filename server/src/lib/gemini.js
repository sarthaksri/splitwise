/**
 * Reading a receipt with Gemini.
 *
 * Google's free tier needs only an API key from aistudio.google.com — no card,
 * no billing account — which is why it's the default engine here. When no key
 * is configured the caller falls back to on-device Tesseract instead, so the
 * app works for anyone who clones it.
 *
 * Structured output is the whole point: `responseSchema` makes the model return
 * JSON matching `SCAN_SCHEMA` rather than prose we'd have to parse. That
 * removes an entire class of "the model explained the bill instead of listing
 * it" failures.
 */

import { SCAN_SCHEMA } from '../../../shared/receipt.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Upstream is missing, rate-limited or broken — all cases where falling back to
 * the on-device engine is the right move rather than showing an error.
 */
export class GeminiUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'GeminiUnavailable';
  }
}

export const hasGeminiKey = () => Boolean(process.env.GEMINI_API_KEY);

const PROMPT = `You are reading a photograph of a restaurant or shop bill.

Extract every ordered line item with its name, quantity and price, plus the
summary amounts. Rules:

- "price" is the amount printed on that line, in major currency units (e.g.
  320.00 means three hundred and twenty rupees). If the line shows a per-unit
  price and a line total, use the LINE TOTAL and set qty to 1, so quantity is
  never applied twice.
- Do not include subtotals, taxes, tips, discounts, rounding or the grand total
  as items. They belong in the dedicated fields.
- Combine CGST, SGST, IGST, VAT and any service tax into a single "tax" total.
- "tip" covers service charge and gratuity. "other" covers delivery, packing
  and container charges. Round-off goes in "other" and may be negative only if
  the bill shows it as a deduction — otherwise omit it.
- "discount" is a positive number meaning the amount taken off.
- "total" is the final amount payable as printed.
- Omit any field the bill does not show. Never guess a number that is not
  legible; leave it out instead.`;

/**
 * @param {{imageBase64: string, mimeType: string}} input
 * @returns {Promise<object>} a raw scan for `normalizeScan`
 * @throws {GeminiUnavailable}
 */
export async function extractReceipt({ imageBase64, mimeType }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiUnavailable('no API key configured');

  // A hung upstream must not burn the whole serverless budget — fail fast and
  // let the browser try Tesseract instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${MODEL}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // Header rather than a query string, so the key can't end up in a
        // proxy or access log.
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: PROMPT }, { inlineData: { mimeType, data: imageBase64 } }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SCAN_SCHEMA,
          // Reading numbers off a page is not a creative task.
          temperature: 0,
        },
      }),
    });
  } catch (err) {
    throw new GeminiUnavailable(err.name === 'AbortError' ? 'timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Body may carry a useful reason (bad key, quota exhausted); it never
    // carries the image back, so it is safe to read.
    const detail = await res.text().catch(() => '');
    throw new GeminiUnavailable(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const body = await res.json().catch(() => null);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new GeminiUnavailable('empty response');

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiUnavailable('response was not the JSON we asked for');
  }
}
