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

/**
 * Models to try, in order.
 *
 * Flash Lite leads on quota, not on quality. The free tier allows it **500
 * requests a day at 15/minute**, against **20 a day at 5/minute** for the full
 * Flash models — and this is one project key shared by everybody using the
 * deployment, not a per-user allowance. Twenty scans a day is roughly seven
 * dinners for the entire app, and every attempt in a chain spends one, so
 * leading with Flash would exhaust the day's budget by the evening.
 *
 * One fallback, not three, for the same reason: each extra attempt costs
 * another request from a small pot.
 *
 * Pinning a single model is separately what broke this once already —
 * `gemini-2.5-flash` was retired for new keys, started answering 404, and every
 * scan silently demoted to the on-device engine.
 *
 * GEMINI_MODEL overrides the first entry: set it to `gemini-3.6-flash` for the
 * better reader, and accept 20 scans a day.
 */
const MODELS = [
  process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  'gemini-flash-latest',
].filter((m, i, all) => all.indexOf(m) === i);

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Worth trying the next model rather than giving up: gone, busy, or throttled. */
const TRY_NEXT = new Set([404, 429, 500, 502, 503, 504]);

/**
 * Upstream is missing, rate-limited or broken — all cases where falling back to
 * the on-device engine is the right move rather than showing an error.
 */
export class GeminiUnavailable extends Error {
  /**
   * @param {string} reason for the log
   * @param {'quota'|'upstream'} kind what to tell the user. The free daily
   *   allowance running out is worth distinguishing from a capacity blip:
   *   one comes back tomorrow, the other in a few minutes.
   */
  constructor(reason, kind = 'upstream') {
    super(reason);
    this.name = 'GeminiUnavailable';
    this.kind = kind;
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

  const body = JSON.stringify({
    contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCAN_SCHEMA,
      // Reading numbers off a page is not a creative task.
      temperature: 0,
    },
  });

  /*
   * Bail early and often.
   *
   * Google's free tier answers text in under two seconds but is frequently
   * saturated for image requests, and a saturated endpoint does not refuse
   * quickly — one measured 503 took 98 seconds to arrive. Waiting that out
   * before starting the on-device reader is far worse than not trying at all,
   * so each model gets 8 seconds and the chain as a whole gets 18. When models
   * fail fast, all three are tried in a few seconds; when they hang, the user
   * is scanning locally within 18.
   */
  const deadline = Date.now() + 18_000;
  const failures = [];
  let outOfQuota = false;

  for (const model of MODELS) {
    const remaining = deadline - Date.now();
    if (remaining < 2_000) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 8_000));

    let res;
    try {
      res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // Header rather than a query string, so the key can't end up in a
          // proxy or access log.
          'x-goog-api-key': key,
        },
        body,
      });
    } catch (err) {
      failures.push(`${model}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The body may carry a useful reason (retired model, quota spent); it
      // never carries the image back, so it is safe to read.
      const detail = await res.text().catch(() => '');
      failures.push(`${model}: HTTP ${res.status} ${detail.slice(0, 120)}`);
      // 429 on the free tier is the daily or per-minute allowance, not a fault.
      if (res.status === 429) outOfQuota = true;
      if (TRY_NEXT.has(res.status)) continue;
      // A 400 or 403 is our fault or the key's — the next model would fail the
      // same way, so stop rather than hammering three of them.
      break;
    }

    const payload = await res.json().catch(() => null);
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      failures.push(`${model}: empty response`);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      failures.push(`${model}: response was not the JSON we asked for`);
    }
  }

  throw new GeminiUnavailable(
    failures.join(' | ') || 'no model responded',
    outOfQuota ? 'quota' : 'upstream',
  );
}
