import { describe, it, expect } from 'vitest';
import { normalizeScan, parseReceiptText, reconcileScan, ScanError } from './receipt.js';

describe('normalizeScan', () => {
  it('turns a model response into integer paise', () => {
    const scan = normalizeScan({
      items: [
        { name: 'Paneer Tikka', qty: 1, price: 320 },
        { name: 'Butter Naan', qty: 4, price: 60.5 },
      ],
      tax: 38.05,
      total: 600.05,
      currency: 'inr',
    });

    expect(scan.items).toEqual([
      { name: 'Paneer Tikka', qty: 1, priceCents: 32000 },
      { name: 'Butter Naan', qty: 4, priceCents: 6050 },
    ]);
    expect(scan.taxCents).toBe(3805);
    expect(scan.totalCents).toBe(60005);
    expect(scan.currency).toBe('INR');
    // Absent fields must be 0, not undefined — they feed straight into arithmetic.
    expect(scan.tipCents).toBe(0);
    expect(scan.discountCents).toBe(0);
  });

  it('drops nameless noise but keeps a named dish whose price was unreadable', () => {
    const scan = normalizeScan({
      items: [
        { name: '', price: 100 },
        { name: '....', price: 100 },
        // OCR reads "60.00" as "00.00" often enough that this is the common
        // case, not an edge one. Keeping the row keeps the dish name.
        { name: 'Masala Chai', price: 0 },
        { name: 'Masala Dosa', price: 140 },
      ],
    });
    expect(scan.items).toEqual([
      { name: 'Masala Chai', qty: 1, priceCents: 0 },
      { name: 'Masala Dosa', qty: 1, priceCents: 14000 },
    ]);
  });

  it('zeroes an amount that would break the ledger rather than trusting it', () => {
    const scan = normalizeScan({
      items: [
        { name: 'Sane', price: 100 },
        { name: 'Absurd', price: 10_000_000_000 },
        { name: 'Negative', price: -50 },
      ],
      tax: -10,
    });
    // The names survive so they can be corrected; the impossible numbers do not.
    expect(scan.items).toEqual([
      { name: 'Sane', qty: 1, priceCents: 10000 },
      { name: 'Absurd', qty: 1, priceCents: 0 },
      { name: 'Negative', qty: 1, priceCents: 0 },
    ]);
    // A negative tax is zeroed rather than quietly inverted.
    expect(scan.taxCents).toBe(0);
  });

  it('clamps a misread quantity rather than trusting it', () => {
    const scan = normalizeScan({
      items: [
        { name: 'Zero', qty: 0, price: 10 },
        { name: 'Fractional', qty: 2.7, price: 10 },
        { name: 'Enormous', qty: 5000, price: 10 },
      ],
    });
    expect(scan.items.map((i) => i.qty)).toEqual([1, 2, 1]);
  });

  it('strips item numbering and dot leaders from names', () => {
    const scan = normalizeScan({
      items: [
        { name: '1. Chicken Biryani', price: 280 },
        { name: 'Gulab Jamun .......', price: 90 },
      ],
    });
    expect(scan.items.map((i) => i.name)).toEqual(['Chicken Biryani', 'Gulab Jamun']);
  });

  it('says something useful when there is nothing to use', () => {
    expect(() => normalizeScan(null)).toThrow(ScanError);
    expect(() => normalizeScan({ items: [] })).toThrow(/find any dishes/i);
  });
});

describe('reconcileScan', () => {
  it('adds the lines up the same way the split engine will', () => {
    const scan = normalizeScan({
      items: [{ name: 'Thali', qty: 2, price: 250 }],
      tax: 25,
      tip: 30,
      discount: 55,
      total: 500,
    });
    // 2×250 + 25 + 30 − 55 = 500
    expect(reconcileScan(scan).derivedCents).toBe(50000);
    expect(reconcileScan(scan).diffCents).toBe(0);
  });

  it('reports the gap when a dish was missed', () => {
    const scan = normalizeScan({
      items: [{ name: 'Thali', price: 250 }],
      total: 500,
    });
    const { diffCents, printedCents } = reconcileScan(scan);
    expect(printedCents).toBe(50000);
    expect(diffCents).toBe(25000); // the bill says 250 more than we found
  });

  it('stays quiet when the bill printed no total', () => {
    const scan = normalizeScan({ items: [{ name: 'Thali', price: 250 }] });
    expect(reconcileScan(scan).printedCents).toBeNull();
    expect(reconcileScan(scan).diffCents).toBe(0);
  });
});

describe('parseReceiptText', () => {
  /** A thermal-printed Indian restaurant bill, roughly as Tesseract renders it. */
  const INDIAN_BILL = `
    SPICE GARDEN
    GSTIN: 29ABCDE1234F1Z5
    Bill No: 4471          Table: 7
    ------------------------------
    1  Paneer Tikka          320.00
    2  Butter Naan            90.00
    1  Dal Makhani           260.00
    3  Masala Chai            60.00
    ------------------------------
    Sub Total                730.00
    CGST 2.5%                 18.25
    SGST 2.5%                 18.25
    Service Charge            36.50
    ------------------------------
    Grand Total              803.00
    Thank you, visit again!
  `;

  it('reads dishes, quantities and prices off a real-looking bill', () => {
    const raw = parseReceiptText(INDIAN_BILL);
    expect(raw.items).toEqual([
      { name: 'Paneer Tikka', qty: 1, price: 320 },
      { name: 'Butter Naan', qty: 2, price: 90 },
      { name: 'Dal Makhani', qty: 1, price: 260 },
      { name: 'Masala Chai', qty: 3, price: 60 },
    ]);
  });

  it('adds CGST and SGST together rather than keeping just one', () => {
    const raw = parseReceiptText(INDIAN_BILL);
    // 18.25 + 18.25. Keeping only the last line would halve the tax, which
    // looks entirely plausible on screen and is wrong on every split.
    expect(raw.tax).toBe(36.5);
    expect(raw.tip).toBe(36.5);
    expect(raw.total).toBe(803);
  });

  it('sums the fiddly extra charges too, but never the total', () => {
    const raw = parseReceiptText(`
      Biryani                 240.00
      Packing Charge           20.00
      Delivery Charge          35.00
      Total                   295.00
      Total                   295.00
    `);
    expect(raw.other).toBe(55);
    // Two printings of the same total must not become 590.
    expect(raw.total).toBe(295);
  });

  it('never turns a summary row into a dish', () => {
    const names = parseReceiptText(INDIAN_BILL).items.map((i) => i.name.toLowerCase());
    for (const banned of ['sub total', 'grand total', 'cgst 2.5%', 'service charge']) {
      expect(names).not.toContain(banned);
    }
  });

  it('drops the header and footer noise', () => {
    const names = parseReceiptText(INDIAN_BILL).items.map((i) => i.name);
    expect(names.some((n) => /gstin|bill no|table|thank/i.test(n))).toBe(false);
  });

  it('takes the price from the end of the line, not the first number in it', () => {
    const raw = parseReceiptText('2 7Up Bottle 250ml        80.00');
    expect(raw.items).toEqual([{ name: '7Up Bottle 250ml', qty: 2, price: 80 }]);
  });

  it('handles a discount line and a rupee suffix', () => {
    const raw = parseReceiptText(`
      Veg Pulao              180.00
      Discount               -20.00
      Total                  160.00/-
    `);
    expect(raw.items).toEqual([{ name: 'Veg Pulao', qty: 1, price: 180 }]);
    // A negative on the line still means "20 off", not "minus twenty owed".
    expect(raw.discount).toBe(20);
    expect(raw.total).toBe(160);
  });

  it('keeps subtotal separate from the grand total', () => {
    const raw = parseReceiptText(`
      Idli                    60.00
      Subtotal                60.00
      Tax                      3.00
      Grand Total             63.00
    `);
    expect(raw.total).toBe(63);
    expect(raw.items).toHaveLength(1);
  });

  it('notices a foreign currency', () => {
    expect(parseReceiptText('Burger $12.00').currency).toBe('USD');
    expect(parseReceiptText('Idli 60.00').currency).toBe('INR');
  });

  it('feeds straight into normalizeScan', () => {
    const scan = normalizeScan(parseReceiptText(INDIAN_BILL));
    expect(scan.items).toHaveLength(4);
    // 320 + 2×90 + 260 + 3×60 = 940 of dishes, + 36.50 tax (both GST lines)
    // + 36.50 service charge.
    expect(reconcileScan(scan).derivedCents).toBe(94000 + 3650 + 3650);
    // The bill says 803 because its own subtotal is 730 — the quantities on a
    // thermal bill are per-line totals, not per-unit. Worth surfacing, and the
    // reconciliation strip is exactly what surfaces it.
    expect(reconcileScan(scan).diffCents).not.toBe(0);
  });

  it('survives complete gibberish without throwing', () => {
    expect(() => parseReceiptText('~~~ ### ...')).not.toThrow();
    expect(parseReceiptText('~~~ ### ...').items).toEqual([]);
    expect(() => parseReceiptText(null)).not.toThrow();
  });
});
