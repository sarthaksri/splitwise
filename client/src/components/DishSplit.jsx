import { useEffect, useRef } from 'react';
import { formatMoney } from '@shared/money.js';
import { itemTotalCents } from '@shared/splitEngine.js';
import { Avatar } from './ui.jsx';
import { MoneyInput } from './MoneyInput.jsx';
import { ScanBillButton } from './ScanBillButton.jsx';

const blankItem = () => ({ key: crypto.randomUUID(), name: '', priceCents: 0, qty: 1, sharedBy: [] });

export { blankItem };

/**
 * The dish-wise editor: one row per dish, with avatar chips for who shared it,
 * then the tax/tip/discount that get spread proportionally over those dishes.
 *
 * A scanned bill lands straight in here rather than in a separate review step —
 * this form *is* the review, and it already shows a running subtotal and warns
 * about a dish nobody is assigned to.
 */
export function DishSplit({
  items,
  setItems,
  extras,
  setExtras,
  people,
  onScanned,
  scan,
  onDismissScan,
}) {
  const update = (key, patch) =>
    setItems(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const toggleEater = (item, userId) => {
    const has = item.sharedBy.includes(userId);
    update(item.key, {
      sharedBy: has ? item.sharedBy.filter((id) => id !== userId) : [...item.sharedBy, userId],
    });
  };

  const allIds = people.map((p) => p.id);
  const isPercent = extras.discountMode === 'percent';
  const subtotal = items.reduce((sum, item) => {
    try {
      return sum + itemTotalCents(item);
    } catch {
      return sum;
    }
  }, 0);

  // What the bill said versus what the rows currently add up to. Recomputed as
  // you edit, so fixing a misread dish makes the warning go away by itself.
  const printedTotal = scan?.printedCents ?? null;
  const currentTotal =
    subtotal + extras.taxCents + extras.tipCents + extras.otherCents -
    (extras.discountMode === 'percent'
      ? Math.round((subtotal * (extras.discountBps ?? 0)) / 10000)
      : extras.discountCents);
  const gapCents = printedTotal == null ? 0 : printedTotal - currentTotal;

  /*
   * Bring the result into view once a scan lands.
   *
   * The dish rows and the reconciliation warning appear well below the fold on
   * a phone — the form starts at Description and the split tabs are already a
   * screenful down. Leaving the user looking at an unchanged screen makes the
   * scan seem to have done nothing, and hides the one warning that matters.
   */
  const scanPanel = useRef(null);
  useEffect(() => {
    if (scan) scanPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scan]);

  return (
    <div className="space-y-3">
      {onScanned && <ScanBillButton onScanned={onScanned} />}

      {scan && (
        <div ref={scanPanel} className="space-y-2 rounded-xl border border-line bg-sunken p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold text-fg">
              Filled in from your photo
              <span className="ml-1.5 font-normal text-fg-subtle">
                {scan.provider === 'tesseract'
                  ? scan.reason === 'upstream'
                    ? // Temporary, and not the app being bad at its job — say so,
                      // or a rough result looks like the only result available.
                      'the online reader was busy, so this was read on your device'
                    : 'read on your device'
                  : 'read online'}
              </span>
            </p>
            <button
              type="button"
              onClick={onDismissScan}
              className="icon-btn shrink-0 p-1 text-fg-subtle hover:bg-hover hover:text-fg"
              aria-label="Dismiss scan notes"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Every dish starts shared by everyone, so the common case is one
              tap. The flip side is that a dish you forget to untick is charged
              to people who didn't eat it — worth saying out loud. */}
          <p className="text-xs text-fg-muted">
            Every dish is ticked for everyone. <b>Untick anyone who didn&apos;t have one</b>,
            and check the prices — a scan gets things wrong sometimes.
          </p>

          {printedTotal != null && (
            <p
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                gapCents === 0 ? 'bg-accent-soft text-accent-soft-fg' : 'bg-warn-soft text-warn-fg'
              }`}
            >
              {gapCents === 0 ? (
                <>Adds up to the {formatMoney(printedTotal)} printed on the bill ✓</>
              ) : (
                <>
                  The bill says {formatMoney(printedTotal)} but these rows come to{' '}
                  {formatMoney(currentTotal)} —{' '}
                  {gapCents > 0
                    ? `${formatMoney(gapCents)} short, so a dish or a charge was probably missed.`
                    : `${formatMoney(-gapCents)} over, so something was probably read twice.`}
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {items.map((item, index) => {
          const everyone = allIds.length > 0 && allIds.every((id) => item.sharedBy.includes(id));
          return (
            <div
              key={item.key}
              className={`rounded-xl border p-3 ${
                item.sharedBy.length === 0 ? 'border-warn-line bg-warn-soft' : 'border-line'
              }`}
            >
              {/* The name takes a whole row on a phone. Sharing one line with
                  the quantity, the price and the delete button leaves it about
                  90px wide, which shows "Pane" for "Paneer Tikka" — fine when
                  you typed it, useless when you're checking what a scan read. */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-0 flex-1 basis-full sm:basis-auto"
                  placeholder={`Dish ${index + 1}`}
                  value={item.name}
                  onChange={(e) => update(item.key, { name: e.target.value })}
                />
                <input
                  type="number"
                  min="1"
                  className="input w-16 text-center tabular-nums"
                  title="Quantity"
                  value={item.qty}
                  onChange={(e) =>
                    update(item.key, { qty: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
                <MoneyInput
                  className="w-28 min-w-0 flex-1 sm:flex-none"
                  placeholder="Price"
                  valueCents={item.priceCents}
                  onChangeCents={(cents) => update(item.key, { priceCents: cents })}
                />
                <button
                  type="button"
                  onClick={() => setItems(items.filter((i) => i.key !== item.key))}
                  className="icon-btn p-1.5 text-fg-subtle hover:bg-danger-soft hover:text-danger-fg"
                  aria-label={`Remove ${item.name || `dish ${index + 1}`}`}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-fg-muted">Shared by</span>
                {people.map((person) => {
                  const on = item.sharedBy.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => toggleEater(item, person.id)}
                      aria-pressed={on}
                      className={`chip-tap flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-xs font-medium transition ${
                        on
                          ? 'border-brand-500 bg-accent-soft text-accent-soft-fg'
                          : 'border-line text-fg-muted opacity-60 hover:opacity-100'
                      }`}
                    >
                      <Avatar user={person} size={20} />
                      {person.name.split(' ')[0]}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => update(item.key, { sharedBy: everyone ? [] : allIds })}
                  className="ml-1 rounded-full btn-compact font-semibold text-brand-600 hover:bg-accent-soft"
                >
                  {everyone ? 'None' : 'Everyone'}
                </button>
              </div>

              {item.sharedBy.length === 0 && (
                <p className="mt-2 text-xs font-medium text-warn-fg">
                  Pick who shared this dish.
                </p>
              )}
              {item.sharedBy.length > 1 && item.priceCents > 0 && (
                <p className="mt-2 text-xs text-fg-subtle">
                  {formatMoney(Math.floor(itemTotalCents(item) / item.sharedBy.length))} each
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setItems([...items, blankItem()])}
        className="btn-secondary w-full border-dashed"
      >
        + Add a dish
      </button>

      <div className="rounded-xl border border-line p-3">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-fg-muted">Dishes subtotal</span>
          <span className="font-semibold tabular-nums text-fg">
            {formatMoney(subtotal)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['taxCents', 'Tax / GST'],
            ['tipCents', 'Tip'],
            ['otherCents', 'Other'],
          ].map(([field, label]) => (
            <div key={field}>
              <label className="label" htmlFor={`extra-${field}`}>{label}</label>
              <MoneyInput
                id={`extra-${field}`}
                valueCents={extras[field]}
                onChangeCents={(cents) => setExtras({ ...extras, [field]: cents })}
              />
            </div>
          ))}

          <div>
            <div className="mb-1 flex items-center justify-between gap-1">
              <label className="label mb-0" htmlFor="extra-discount">Discount</label>
              {/* ₹ or % — a menu discount is usually quoted as a percentage. */}
              <div className="flex overflow-hidden rounded-md border border-line text-[10px] font-semibold">
                {[
                  ['amount', '₹'],
                  ['percent', '%'],
                ].map(([mode, symbol]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={isPercent === (mode === 'percent')}
                    onClick={() => setExtras({ ...extras, discountMode: mode })}
                    className={`icon-btn rounded-none px-2 py-1 transition ${
                      isPercent === (mode === 'percent')
                        ? 'bg-brand-500 text-white'
                        : 'bg-surface text-fg-muted hover:bg-hover'
                    }`}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            </div>

            {isPercent ? (
              <div className="relative">
                <input
                  id="extra-discount"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  className="input pr-6 text-right tabular-nums"
                  value={extras.discountBps ? extras.discountBps / 100 : ''}
                  placeholder="0"
                  onChange={(e) => {
                    const pct = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                    setExtras({ ...extras, discountBps: Math.round(pct * 100) });
                  }}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
                  %
                </span>
              </div>
            ) : (
              <MoneyInput
                id="extra-discount"
                valueCents={extras.discountCents}
                onChangeCents={(cents) => setExtras({ ...extras, discountCents: cents })}
              />
            )}
          </div>
        </div>

        {isPercent && extras.discountBps > 0 && (
          <p className="mt-1.5 text-xs font-medium text-accent-soft-fg">
            {extras.discountBps / 100}% off {formatMoney(subtotal)} = −
            {formatMoney(Math.round((subtotal * extras.discountBps) / 10000))}
          </p>
        )}
        <p className="mt-2 text-xs text-fg-subtle">
          Tax, tip and discounts are shared out in proportion to what each person ate.
          {isPercent ? ' The percentage comes off the dishes, before tax.' : ''}
        </p>
      </div>
    </div>
  );
}
