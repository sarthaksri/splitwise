import { formatMoney } from '@shared/money.js';
import { itemTotalCents } from '@shared/splitEngine.js';
import { Avatar } from './ui.jsx';
import { MoneyInput } from './MoneyInput.jsx';

const blankItem = () => ({ key: crypto.randomUUID(), name: '', priceCents: 0, qty: 1, sharedBy: [] });

export { blankItem };

/**
 * The dish-wise editor: one row per dish, with avatar chips for who shared it,
 * then the tax/tip/discount that get spread proportionally over those dishes.
 */
export function DishSplit({ items, setItems, extras, setExtras, people }) {
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

  return (
    <div className="space-y-3">
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
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-0 flex-1"
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
                  className="w-28"
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
