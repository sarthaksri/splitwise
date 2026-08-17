import { describe, it, expect } from 'vitest';
import {
  mergeRawScans,
  normalizeScan,
  parseReceiptPages,
  parseReceiptText,
  reconcileScan,
  ScanError,
} from './receipt.js';

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

  /**
   * A real bill, transcribed from a photo of one: the dish name sits on its own
   * line and the Qty/Rate/Amount columns land underneath it. This layout is
   * everywhere on Indian POS printers, and it read as a completely empty bill
   * until the parser learned to pair the two lines.
   */
  const TWO_LINE_BILL = `
    Red Rhino
    Dine In
    GSTIN 36AAIFV7298E1ZD
    FSSAI NO 13622013000544
    Bill No: 43088    Date: 08-08-26  Time: 00.36
    Stw: SUJOY   Table No: P38   Covers: 1
    SNo Description
             Qty    Rate    Amount
    1  Lotus Wafers
             1     425.00    425.00
    2  French Fries Spice Dusted
             2     275.00    550.00
    3  Add on Chicken
             1      95.00     95.00
    4  COKE CAN
             1     140.00    140.00
    5  Nachos Ala Rhino
             3     545.00   1635.00
    6  Creamy Penne Rosso
             1     500.00    500.00
    7  Long Island Iced Tea
             1     725.00    725.00
    8  Long Beach Ice tea
             2     725.00   1450.00
    9  MANGO CIDER 500ML
             8     575.00   4600.00
    10  BULLFROG
             2     725.00   1450.00
    11  Soul Serfer 500 ml
             1     425.00    425.00
    12  Bangalore Daze 500 ml
             3     450.00   1350.00
    Total Amount            13345.00
    Service Charge @ 10%        0.00
    State Gst @ 2.5%           83.65
    Central Gst @ 2.5%         83.65
    Round Off                  -0.30
    Net Amount              13512.00
    Total Items : 26
    HSN / SAC :
      Food:996331
    User ID: JITENDRA
  `;

  it('pairs a dish name with the figures printed on the line below it', () => {
    const raw = parseReceiptText(TWO_LINE_BILL);
    expect(raw.items).toHaveLength(12);
    expect(raw.items[0]).toEqual({ name: 'Lotus Wafers', qty: 1, price: 425 });
    expect(raw.items[1]).toEqual({ name: 'French Fries Spice Dusted', qty: 2, price: 275 });
    expect(raw.items[8]).toEqual({ name: 'MANGO CIDER 500ML', qty: 8, price: 575 });
  });

  it('uses the rate, not the line total, when quantity is more than one', () => {
    const raw = parseReceiptText(TWO_LINE_BILL);
    // "2  275.00  550.00" must not become 2 × ₹550. The dishes have to add up
    // to the ₹13,345 the bill itself prints.
    const dishes = raw.items.reduce((sum, i) => sum + i.price * i.qty, 0);
    expect(dishes).toBeCloseTo(13345, 2);
  });

  it('keeps the header, the serial numbers and the footer out of the dishes', () => {
    const names = parseReceiptText(TWO_LINE_BILL).items.map((i) => i.name);
    expect(names).not.toContain('Description');
    expect(names.some((n) => /qty|rate|amount|hsn|user id|covers|stw/i.test(n))).toBe(false);
    // The serial number is stripped, but a name that starts with a digit is not.
    expect(names[0]).toBe('Lotus Wafers');
  });

  it('reads that bill\'s summary block exactly', () => {
    const raw = parseReceiptText(TWO_LINE_BILL);
    expect(raw.tax).toBeCloseTo(167.3, 2); // 83.65 State + 83.65 Central
    expect(raw.tip).toBe(0); // service charge at 10% came to nothing
    expect(raw.discount).toBeCloseTo(0.3, 2); // a negative round-off is money off
    // "Total Items : 26" must not clobber this, and it is printed afterwards.
    expect(raw.total).toBe(13512);
  });

  it('reconciles that bill to the paise', () => {
    const scan = normalizeScan(parseReceiptText(TWO_LINE_BILL));
    // 13345 dishes + 167.30 tax − 0.30 round-off = 13512.00 exactly.
    expect(reconcileScan(scan).diffCents).toBe(0);
  });

  it('is not fooled by an item count OCR has mangled into a total', () => {
    // Tesseract really does read "Total Items" as "Total Ttems", which slips
    // past a keyword guard. Taking the largest candidate does not care.
    const raw = parseReceiptText(`
      Biryani                240.00
      Total Amount           240.00
      Gst                     12.00
      Net Amount             252.00
      Total Ttems : 17
    `);
    expect(raw.total).toBe(252);
  });

  it('prefers the grand total over the subtotal printed above it', () => {
    const raw = parseReceiptText(`
      Pasta                  500.00
      Total Amount           500.00
      Service Charge          50.00
      Net Amount             550.00
    `);
    expect(raw.total).toBe(550);
  });

  it('survives complete gibberish without throwing', () => {
    expect(() => parseReceiptText('~~~ ### ...')).not.toThrow();
    expect(parseReceiptText('~~~ ### ...').items).toEqual([]);
    expect(() => parseReceiptText(null)).not.toThrow();
  });
});

describe('a bill photographed in several pieces', () => {
  // A long receipt shot in two overlapping halves. The photographer aimed to
  // overlap — otherwise a line falls in the gap between the two shots — so
  // "Butter Naan" and "Dal Makhani" appear on both.
  const topHalf = `
    Red Rhino
    Paneer Tikka          320.00
    Butter Naan            45.00
    Dal Makhani           280.00
  `;
  const bottomHalf = `
    Butter Naan            45.00
    Dal Makhani           280.00
    Gulab Jamun           120.00
    Sub Total             765.00
    CGST 2.5%              19.13
    SGST 2.5%              19.13
    Net Amount            803.26
  `;

  it('reads one bill out of two overlapping photos', () => {
    const raw = parseReceiptPages([topHalf, bottomHalf]);
    expect(raw.items.map((i) => i.name)).toEqual([
      'Paneer Tikka',
      'Butter Naan',
      'Dal Makhani',
      'Gulab Jamun',
    ]);
    expect(raw.total).toBe(803.26);
  });

  it('charges a dish photographed twice only once', () => {
    const both = parseReceiptPages([topHalf, bottomHalf]);
    const scan = normalizeScan(both);
    const dishes = scan.items.reduce((sum, i) => sum + i.priceCents * i.qty, 0);
    // 320 + 45 + 280 + 120, each at qty 1 — not the 645 a naive concatenation
    // would produce by billing the overlap twice.
    expect(dishes).toBe(76500);
  });

  it('does not double the tax that appears on both photos', () => {
    // 19.13 + 19.13 summed within one photo; not added again for the second.
    const overlapping = parseReceiptPages([bottomHalf, bottomHalf]);
    expect(overlapping.tax).toBeCloseTo(38.26, 2);
  });

  it('reconciles the whole bill against the total printed on the last photo', () => {
    const scan = normalizeScan(parseReceiptPages([topHalf, bottomHalf]));
    const { diffCents } = reconcileScan(scan);
    // 76500 dishes + 3826 tax = 80326, exactly the printed Net Amount.
    expect(diffCents).toBe(0);
  });

  it('keeps a dish genuinely ordered twice at different points in the meal', () => {
    // Two rounds of the same drink, printed apart from each other rather than
    // repeated at the seam between photos.
    const raw = parseReceiptPages([
      `
        Beer                  250.00
        Peanuts               100.00
        Beer                  250.00
      `,
    ]);
    expect(raw.items.map((i) => i.name)).toEqual(['Beer', 'Peanuts', 'Beer']);
  });

  it('reads a bill that simply continues onto a second page', () => {
    // No overlap at all: page two carries on where page one stopped.
    const raw = parseReceiptPages([
      'Soup                  150.00',
      `
        Biryani               400.00
        Total                 550.00
      `,
    ]);
    expect(raw.items.map((i) => i.name)).toEqual(['Soup', 'Biryani']);
    expect(raw.total).toBe(550);
  });

  it('behaves exactly like the single-photo parser when given one photo', () => {
    expect(parseReceiptPages([topHalf])).toEqual(parseReceiptText(topHalf));
  });

  it('ignores a photo that came back empty rather than losing the others', () => {
    const raw = parseReceiptPages(['Soup 150.00', '', '   ']);
    expect(raw.items).toHaveLength(1);
  });

  it('takes the larger reading of a summary line, never the sum', () => {
    // The same total, read once cleanly and once with a digit dropped.
    const merged = mergeRawScans([{ items: [], total: 803.26 }, { items: [], total: 80.26 }]);
    expect(merged.total).toBe(803.26);
  });

  it('stops at a sane number of photos', () => {
    const pages = Array.from({ length: 12 }, (_, i) => `Dish${i} 10.00`);
    expect(parseReceiptPages(pages).items).toHaveLength(8);
  });

  it('survives nonsense in the list without throwing', () => {
    expect(() => mergeRawScans([null, undefined, 'nope', { items: null }])).not.toThrow();
    expect(mergeRawScans([]).items).toEqual([]);
  });
});

describe('a tax line whose keyword OCR destroyed', () => {
  it('still reads it as tax, by the percentage on it', () => {
    // Exactly what Tesseract returned for a rendered "CGST 2.5% / SGST 2.5%".
    const raw = parseReceiptText(`
      Kulfi                 110.00
      Sub Total            1440.00
      CEST 2.:5%             36.00
      SESE 21.5%             36.00
      Grand Total          1512.00
    `);
    expect(raw.tax).toBe(72);
    // And it is not offered as something somebody ate.
    expect(raw.items.map((i) => i.name)).toEqual(['Kulfi']);
  });

  it('does not steal a percentage discount or a service charge', () => {
    const raw = parseReceiptText(`
      Pizza                 400.00
      Service Charge 10%     40.00
      Discount 5%           -20.00
      Total                 420.00
    `);
    expect(raw.tip).toBe(40);
    expect(raw.discount).toBe(20);
    expect(raw.tax).toBeUndefined();
  });
});
