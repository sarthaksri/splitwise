import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@shared/money.js';
import {
  computeShares,
  itemizedTotalCents,
  normalizePayers,
  SPLIT_TYPES,
} from '@shared/splitEngine.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useGroups, useSaveExpense } from '../hooks/queries.js';
import { Avatar, ErrorNote, Modal, Spinner } from './ui.jsx';
import { MoneyInput } from './MoneyInput.jsx';
import { DishSplit, blankItem } from './DishSplit.jsx';

const MODES = [
  { type: SPLIT_TYPES.EQUAL, label: 'Equally' },
  { type: SPLIT_TYPES.EXACT, label: 'Unequally' },
  { type: SPLIT_TYPES.PERCENT, label: 'Percentages' },
  { type: SPLIT_TYPES.SHARES, label: 'Shares' },
  { type: SPLIT_TYPES.ITEMIZED, label: 'By dish' },
];

const CATEGORIES = [
  'general', 'food', 'groceries', 'rent', 'utilities',
  'transport', 'entertainment', 'shopping', 'travel', 'health', 'other',
];

const emptyExtras = {
  taxCents: 0,
  tipCents: 0,
  otherCents: 0,
  // A discount can be a flat amount or a percentage of the dishes subtotal.
  discountMode: 'amount',
  discountCents: 0,
  discountBps: 0,
};

/**
 * Add or edit an expense.
 *
 * The live preview runs the *same* split engine the server will run, so what
 * you see while typing is exactly what gets saved — and an invalid split is
 * caught here with a specific message rather than after a round trip.
 */
export function ExpenseModal({ open, onClose, group, people: peopleProp, expense }) {
  const { user } = useAuth();
  const save = useSaveExpense();
  const isEdit = Boolean(expense);

  // Opened from the dashboard there's no group yet, so we ask for one: everyone
  // who can pay or owe has to be a member, which is what keeps balances sound.
  const { data: groupsData } = useGroups();
  const groups = groupsData?.groups ?? [];
  const [groupId, setGroupId] = useState(null);

  // Falls back to the first group so the form is usable the moment the list
  // loads — the modal often opens before that request has come back.
  const activeGroup = useMemo(
    () => group ?? groups.find((g) => g._id === groupId) ?? groups[0] ?? null,
    [group, groups, groupId],
  );

  const people = useMemo(() => {
    if (group && peopleProp?.length) return peopleProp;
    const members = activeGroup?.members ?? [];
    return members.map((m) => ({
      id: m.user._id ?? m.user.id,
      name: m.user.name,
      username: m.user.username,
      avatarColor: m.user.avatarColor,
    }));
  }, [peopleProp, group, activeGroup]);

  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amountCents, setAmountCents] = useState(0);
  const [splitType, setSplitType] = useState(SPLIT_TYPES.EQUAL);
  const [participants, setParticipants] = useState([]);
  const [exact, setExact] = useState({});
  const [percent, setPercent] = useState({});
  const [weights, setWeights] = useState({});
  const [items, setItems] = useState([blankItem()]);
  const [extras, setExtras] = useState(emptyExtras);
  const [payers, setPayers] = useState({});
  const [multiPayer, setMultiPayer] = useState(false);

  // (Re)seed the form whenever it opens, from the expense being edited or from
  // sensible defaults for a new one.
  useEffect(() => {
    if (!open) return;
    save.reset();

    if (expense) {
      const ids = expense.shares.map((s) => String(s.user._id ?? s.user));
      setDescription(expense.description);
      setCategory(expense.category ?? 'general');
      setDate(new Date(expense.date).toISOString().slice(0, 10));
      setAmountCents(expense.amountCents);
      setSplitType(expense.splitType);
      setParticipants(expense.splitConfig?.participants ?? ids);
      setExact(
        expense.splitConfig?.exact ??
          Object.fromEntries(
            expense.shares.map((s) => [String(s.user._id ?? s.user), s.amountCents]),
          ),
      );
      setPercent(expense.splitConfig?.percentBps ?? {});
      setWeights(expense.splitConfig?.weights ?? {});
      setItems(
        expense.items?.length
          ? expense.items.map((i) => ({
              key: crypto.randomUUID(),
              name: i.name,
              priceCents: i.priceCents,
              qty: i.qty ?? 1,
              sharedBy: (i.sharedBy ?? []).map((u) => String(u._id ?? u)),
            }))
          : [blankItem()],
      );
      setExtras({
        taxCents: expense.taxCents ?? 0,
        tipCents: expense.tipCents ?? 0,
        otherCents: expense.otherCents ?? 0,
        discountMode: expense.discountMode ?? 'amount',
        discountCents: expense.discountCents ?? 0,
        discountBps: expense.discountBps ?? 0,
      });
      setPayers(
        Object.fromEntries(
          expense.paidBy.map((p) => [String(p.user._id ?? p.user), p.amountCents]),
        ),
      );
      setMultiPayer(expense.paidBy.length > 1);
      setGroupId(String(expense.group?._id ?? expense.group ?? '') || null);
    } else {
      setDescription('');
      setCategory('general');
      setDate(new Date().toISOString().slice(0, 10));
      setAmountCents(0);
      setSplitType(SPLIT_TYPES.EQUAL);
      setExact({});
      setPercent({});
      setItems([blankItem()]);
      setExtras(emptyExtras);
      setMultiPayer(false);
      // Default to the group we were opened from, else the first one you're in.
      setGroupId(group?._id ?? groups[0]?._id ?? null);
    }
    // `people` is derived and stable enough; re-seeding on every keystroke would
    // fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense]);

  /**
   * Whenever the set of people changes — opening a new expense, or switching
   * group in the picker — reset everything keyed by person. Carrying a payer
   * over from a group they aren't in would produce an expense the server
   * rightly rejects.
   */
  const peopleKey = people.map((p) => p.id).join(',');
  useEffect(() => {
    if (!open || isEdit) return;
    const ids = people.map((p) => p.id);
    setParticipants(ids);
    setWeights(Object.fromEntries(ids.map((id) => [id, 1])));
    setPayers(ids.includes(user?.id) ? { [user.id]: 0 } : ids[0] ? { [ids[0]]: 0 } : {});
    setItems((prev) => prev.map((item) => ({ ...item, sharedBy: [] })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, peopleKey, user?.id]);

  const isItemized = splitType === SPLIT_TYPES.ITEMIZED;

  // For dish-wise the dishes define the total, so the amount field mirrors them.
  const effectiveAmount = useMemo(() => {
    if (!isItemized) return amountCents;
    try {
      return itemizedTotalCents({ items, ...extras });
    } catch {
      return 0;
    }
  }, [isItemized, amountCents, items, extras]);

  // The live split preview — the same computation the server will redo.
  const preview = useMemo(() => {
    try {
      const result = computeShares({
        splitType,
        amountCents: isItemized ? undefined : amountCents,
        participants,
        exact,
        percentBps: percent,
        weights,
        items: isItemized ? items : undefined,
        ...(isItemized ? extras : {}),
      });
      return { shares: result.sharesMap, error: null };
    } catch (err) {
      return { shares: new Map(), error: err };
    }
  }, [splitType, amountCents, participants, exact, percent, weights, items, extras, isItemized]);

  // Payer side: one payer covers the whole bill unless you switch to multiple.
  const payerTotal = Object.values(payers).reduce((a, b) => a + (b || 0), 0);
  // Default to you, or failing that the first person in the group, so the form
  // is never stuck in a state with nobody paying.
  const singlePayerId = Object.keys(payers)[0] ?? user?.id ?? people[0]?.id;
  const resolvedPayers = multiPayer
    ? Object.entries(payers)
        .filter(([, cents]) => cents > 0)
        .map(([userId, cents]) => ({ userId, amountCents: cents }))
    : singlePayerId
      ? [{ userId: singlePayerId, amountCents: effectiveAmount }]
      : [];

  const payerError = (() => {
    if (effectiveAmount <= 0) return null;
    try {
      normalizePayers(resolvedPayers, effectiveAmount);
      return null;
    } catch (err) {
      return err;
    }
  })();

  const remainingCents = multiPayer ? effectiveAmount - payerTotal : 0;
  const blocked =
    Boolean(preview.error || payerError) ||
    effectiveAmount <= 0 ||
    !description.trim() ||
    people.length === 0;

  async function onSubmit(e) {
    e.preventDefault();
    const body = {
      id: expense?._id,
      group: activeGroup?._id ?? null,
      description: description.trim(),
      category,
      date,
      splitType,
      paidBy: resolvedPayers,
      ...(isItemized
        ? {
            items: items.map(({ name, priceCents, qty, sharedBy }) => ({
              name, priceCents, qty, sharedBy,
            })),
            ...extras,
          }
        : { amountCents }),
      ...(splitType === SPLIT_TYPES.EQUAL ? { participants } : {}),
      ...(splitType === SPLIT_TYPES.EXACT ? { exact } : {}),
      ...(splitType === SPLIT_TYPES.PERCENT ? { percentBps: percent } : {}),
      ...(splitType === SPLIT_TYPES.SHARES ? { weights } : {}),
    };
    await save.mutateAsync(body);
    onClose();
  }

  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? 'Someone';

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit expense' : 'Add an expense'} wide>
      <form onSubmit={onSubmit} className="max-h-[75vh] overflow-y-auto p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="label" htmlFor="exp-desc">Description</label>
            <input
              id="exp-desc"
              required
              autoFocus
              className="input"
              placeholder="Dinner at Bombay Canteen"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="exp-amount">Amount</label>
            {isItemized ? (
              <div className="input flex items-center bg-sunken font-semibold tabular-nums text-fg-muted">
                {formatMoney(effectiveAmount)}
              </div>
            ) : (
              <MoneyInput
                id="exp-amount"
                className="sm:w-36"
                valueCents={amountCents}
                onChangeCents={setAmountCents}
              />
            )}
          </div>
        </div>

        {/* Opened outside a group: choose which one, since payers and
            participants can only be its members. */}
        {!group && (
          <div className="mt-3">
            <label className="label" htmlFor="exp-group">Group</label>
            {groups.length === 0 ? (
              <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn-fg">
                You need a group first — create one from the sidebar, then add the people
                you split with.
              </p>
            ) : (
              <select
                id="exp-group"
                className="input"
                value={activeGroup?._id ?? ''}
                disabled={isEdit}
                onChange={(e) => setGroupId(e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g._id} value={g._id}>
                    {g.name} · {g.members.length} people
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-xs text-fg-subtle">
              {isEdit
                ? 'An expense cannot be moved between groups.'
                : 'Everyone who pays or owes has to be a member of this group.'}
            </p>
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="exp-date">Date</label>
            <input
              id="exp-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="exp-cat">Category</label>
            <select
              id="exp-cat"
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ---- who paid ---- */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">Paid by</span>
            <button
              type="button"
              className="link-btn text-xs font-semibold text-brand-600 hover:underline"
              onClick={() => {
                setMultiPayer(!multiPayer);
                if (!multiPayer && singlePayerId) {
                  setPayers({ [singlePayerId]: effectiveAmount });
                }
              }}
            >
              {multiPayer ? 'Single payer' : 'Multiple people paid'}
            </button>
          </div>

          {multiPayer ? (
            <div className="space-y-1.5 rounded-xl border border-line p-2.5">
              {people.map((person) => (
                <div key={person.id} className="flex items-center gap-2.5">
                  <Avatar user={person} size={28} />
                  <span className="flex-1 truncate text-sm text-fg">{person.name}</span>
                  <MoneyInput
                    className="w-28"
                    valueCents={payers[person.id] ?? 0}
                    onChangeCents={(cents) => setPayers({ ...payers, [person.id]: cents })}
                  />
                </div>
              ))}
              <p
                className={`pt-1 text-right text-xs font-semibold tabular-nums ${
                  remainingCents === 0 ? 'text-fg-subtle' : 'text-owe'
                }`}
              >
                {remainingCents === 0
                  ? 'Payments add up ✓'
                  : `${formatMoney(Math.abs(remainingCents))} ${remainingCents > 0 ? 'left to cover' : 'over'}`}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {people.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => setPayers({ [person.id]: effectiveAmount })}
                  className={`chip-tap flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs font-medium transition ${
                    singlePayerId === person.id
                      ? 'border-brand-500 bg-accent-soft text-accent-soft-fg'
                      : 'border-line text-fg-muted hover:bg-hover'
                  }`}
                >
                  <Avatar user={person} size={22} />
                  {person.id === user?.id ? 'You' : person.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ---- how to split ---- */}
        <div className="mt-4">
          <span className="label">Split</span>
          {/* A grid rather than wrapping flex: five tabs don't fit across a
              phone, and flex-wrap leaves the last one stretched across its own
              row. Three even tiles then two reads as deliberate. */}
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1 sm:grid-cols-5">
            {MODES.map((mode) => (
              <button
                key={mode.type}
                type="button"
                onClick={() => setSplitType(mode.type)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                  splitType === mode.type
                    ? 'bg-surface text-accent-soft-fg shadow-sm'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {splitType === SPLIT_TYPES.EQUAL && (
            <div className="flex flex-wrap gap-1.5">
              {people.map((person) => {
                const on = participants.includes(person.id);
                return (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() =>
                      setParticipants(
                        on
                          ? participants.filter((id) => id !== person.id)
                          : [...participants, person.id],
                      )
                    }
                    aria-pressed={on}
                    className={`chip-tap flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs font-medium transition ${
                      on
                        ? 'border-brand-500 bg-accent-soft text-accent-soft-fg'
                        : 'border-line text-fg-subtle opacity-60 hover:opacity-100'
                    }`}
                  >
                    <Avatar user={person} size={22} />
                    {person.name}
                  </button>
                );
              })}
            </div>
          )}

          {[SPLIT_TYPES.EXACT, SPLIT_TYPES.PERCENT, SPLIT_TYPES.SHARES].includes(splitType) && (
            <div className="space-y-1.5 rounded-xl border border-line p-2.5">
              {people.map((person) => (
                <div key={person.id} className="flex items-center gap-2.5">
                  <Avatar user={person} size={28} />
                  <span className="flex-1 truncate text-sm text-fg">{person.name}</span>
                  {splitType === SPLIT_TYPES.EXACT && (
                    <MoneyInput
                      className="w-28"
                      valueCents={exact[person.id] ?? 0}
                      onChangeCents={(cents) => setExact({ ...exact, [person.id]: cents })}
                    />
                  )}
                  {splitType === SPLIT_TYPES.PERCENT && (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        className="input w-24 text-right tabular-nums"
                        value={(percent[person.id] ?? 0) / 100}
                        onChange={(e) =>
                          setPercent({
                            ...percent,
                            [person.id]: Math.round((Number(e.target.value) || 0) * 100),
                          })
                        }
                      />
                      <span className="text-sm text-fg-subtle">%</span>
                    </div>
                  )}
                  {splitType === SPLIT_TYPES.SHARES && (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="input w-24 text-right tabular-nums"
                      value={weights[person.id] ?? 0}
                      onChange={(e) =>
                        setWeights({ ...weights, [person.id]: Number(e.target.value) || 0 })
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {isItemized && (
            <DishSplit
              items={items}
              setItems={setItems}
              extras={extras}
              setExtras={setExtras}
              people={people}
            />
          )}
        </div>

        {/* ---- live preview ---- */}
        <div className="mt-4 rounded-xl bg-sunken p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Who owes what
          </h3>
          {preview.error ? (
            <p className="text-sm font-medium text-owe">{preview.error.message}</p>
          ) : preview.shares.size === 0 ? (
            <p className="text-sm text-fg-subtle">Enter an amount to see the split.</p>
          ) : (
            <ul className="space-y-1">
              {[...preview.shares].map(([userId, cents]) => (
                <li key={userId} className="flex items-center justify-between text-sm">
                  <span className="text-fg-muted">{nameOf(userId)}</span>
                  <span className="font-semibold tabular-nums text-fg">
                    {formatMoney(cents)}
                  </span>
                </li>
              ))}
              <li className="mt-1 flex items-center justify-between border-t border-line pt-1.5 text-sm">
                <span className="font-semibold text-fg-muted">Total</span>
                <span className="font-bold tabular-nums text-fg">
                  {formatMoney(effectiveAmount)}
                </span>
              </li>
            </ul>
          )}
          {payerError && <p className="mt-2 text-sm font-medium text-owe">{payerError.message}</p>}
        </div>

        <ErrorNote error={save.error} className="mt-3" />

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={blocked || save.isPending}>
            {save.isPending ? (
              <Spinner className="border-white/40 border-t-white" />
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Add expense'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
