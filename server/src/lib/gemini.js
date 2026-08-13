/**
 * Turning the raw text of a receipt into a structured bill.
 *
 * The image is *not* sent here. Tesseract reads the photo in the browser and
 * only its text comes to the server, which is better on three counts:
 *
 *   It works. Google's free tier is routinely saturated for image requests —
 *   measured 503s took between 18 and 306 seconds — while text comes back in
 *   under two seconds. The rate-limit dashboard calls these "text-out models"
 *   for a reason.
 *
 *   It's cheap. A bill's text is a few hundred tokens against a few thousand
 *   for the picture, so a small free allowance goes several times further.
 *
 *   It's private. The photograph of your table, your card digits and where you
 *   were on a Friday night never leaves the device.
 *
 * What it costs: the model sees what OCR *thought* it read, so it cannot undo a
 * misread digit by looking at the paper again. It can, however, notice that the
 * lines do not add up to the printed total and say so — which is why the prompt
 * below asks it to check exactly that.
 *
 * Structured output does the rest: `responseSchema` makes the reply JSON
 * matching `SCAN_SCHEMA`, so there is no prose to parse and no "the model
 * explained the bill instead of listing it" failure mode.
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

const PROMPT = `You are given the raw OCR text of a restaurant or shop bill. Turn it
into structured JSON.

The text came from OCR, so expect it to be messy: columns collapsed into
spaces, a dish name on one line with its figures on the next, characters
confused (O for 0, l or I for 1, S for 5, rn for m), and header, footer and tax
registration lines mixed in among the food. Layouts vary wildly between
restaurants — do not assume any fixed column order.

ITEMS

- Return one entry per ordered line item, with "name", "qty" and "price".
- "price" is the price of ONE unit, in major currency units (320.00 = three
  hundred and twenty rupees), and "qty" is how many were ordered.
- Bills commonly print three columns: Qty, Rate, Amount — where Amount is
  already Qty x Rate. In that case use the RATE as "price" and the printed
  quantity as "qty". Never take Amount as the unit price, or the bill doubles.
- If a line shows only one figure, that figure is the price and qty is 1.
- Keep the dish name as printed, without the serial number in front of it.
- Do NOT return subtotals, taxes, service charges, discounts, rounding, the
  grand total, item counts, HSN/SAC codes, GSTIN, FSSAI, bill or table numbers,
  or KOT numbers as items. They are not food.

SUMMARY FIELDS

- "tax": every tax on the bill ADDED TOGETHER — CGST plus SGST plus IGST, VAT,
  cess, service tax. Indian bills split this across two or more lines and the
  total of them is what matters.
- "tip": service charge or gratuity.
- "other": delivery, packing, container or convenience charges.
- "discount": a positive number meaning the amount taken OFF the bill. A
  negative round-off (e.g. "Round Off -0.30") is a discount of 0.30.
- "total": the final amount payable. If the bill prints both a subtotal and a
  net or grand total, "total" is the LARGER, final one.
- Omit any field the bill does not show. Do not invent numbers.

CHECK YOUR WORK

The items, taxes and charges should reconcile:

    sum(qty x price) + tax + tip + other - discount = total

Before answering, do that arithmetic. If it does not match the printed total,
you have most likely misread a quantity, missed a line, or taken a line total
as a unit price — re-read the text and correct it. If it still does not match,
return what you can actually see rather than adjusting a number to force the
sum: the app shows the user any discrepancy, and an honest gap is far more
useful than a fabricated match.`;

/**
 * @param {{text: string}} input the OCR text of one bill
 * @returns {Promise<object>} a raw scan for `normalizeScan`
 * @throws {GeminiUnavailable}
 */
export async function structureReceipt({ text }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiUnavailable('no API key configured');

  const body = JSON.stringify({
    contents: [{ parts: [{ text: `${PROMPT}\n\n--- BILL TEXT ---\n${text}` }] }],
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
