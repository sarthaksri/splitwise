import { useEffect, useMemo, useState } from 'react';
import { formatMoney } from '@shared/money.js';
import { computeShares, SPLIT_TYPES } from '@shared/splitEngine.js';
import {
  FREQUENCY_LIST,
  FREQUENCY_LABELS,
  describeSchedule,
  occurrencesUpTo,
  nextOccurrence,
  toMonthlyCents,
  cycleKey,
} from '@shared/recurrence.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useSaveRecurring } from '../hooks/queries.js';
import { Avatar, ErrorNote, Modal, Spinner } from './ui.jsx';
import { MoneyInput } from './MoneyInput.jsx';

const CATEGORIES = [
  'general', 'rent', 'utilities', 'groceries', 'food',
  'transport', 'entertainment', 'shopping', 'health', 'other',
];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Set up a bill that repeats — rent, the internet, a cleaner.
 *
 * Recurring expenses are always group-scoped, because a standing commitment
 * needs a fixed set of people. The preview below the form spells out exactly
 * which dates will be created, including any that are already overdue.
 */
export function RecurringModal({ open, onClose, group, people, template }) {
  const { user } = useAuth();
  const save = useSaveRecurring();
  const isEdit = Boolean(template);

  const [description, setDescription] = useState('');
  const [amountCents, setAmountCents] = useState(0);
  const [category, setCategory] = useState('rent');
  const [frequency, setFrequency] = useState('monthly');
  const [interval, setIntervalValue] = useState(1);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [participants, setParticipants] = useState([]);
  const [payerId, setPayerId] = useState(null);

  useEffect(() => {
    if (!open) return;
    save.reset();
    if (template) {
      setDescription(template.description);
      setAmountCents(template.amountCents);
      setCategory(template.category ?? 'general');
      setFrequency(template.frequency);
      setIntervalValue(template.interval ?? 1);
      setStartDate(new Date(template.startDate).toISOString().slice(0, 10));
      setEndDate(template.endDate ? new Date(template.endDate).toISOString().slice(0, 10) : '');
      setParticipants(
        (template.splitConfig?.participants ?? []).map(String),
      );
      setPayerId(String(template.paidBy[0]?.user?._id ?? template.paidBy[0]?.user));
    } else {
      setDescription('');
      setAmountCents(0);
      setCategory('rent');
      setFrequency('monthly');
      setIntervalValue(1);
      setStartDate(today());
      setEndDate('');
      setParticipants(people.map((p) => p.id));
      setPayerId(user?.id ?? people[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  const preview = useMemo(() => {
    if (amountCents <= 0 || participants.length === 0) return null;
    try {
      const { sharesMap } = computeShares({
        splitType: SPLIT_TYPES.EQUAL,
        amountCents,
        participants,
      });
      const schedule = { frequency, interval, startDate, endDate: endDate || null };
      // Cycles already due — created the moment this is saved.
      const overdue = occurrencesUpTo(schedule, new Date());
      const next = nextOccurrence(
        overdue.length ? overdue.at(-1) : startDate,
        { frequency, interval },
        new Date(`${startDate}T00:00:00Z`).getUTCDate(),
      );
      return {
        shares: sharesMap,
        overdue,
        next,
        monthlyCents: toMonthlyCents(amountCents, { frequency, interval }),
        error: null,
      };
    } catch (err) {
      return { error: err };
    }
  }, [amountCents, participants, frequency, interval, startDate, endDate]);

  async function onSubmit(e) {
    e.preventDefault();
    await save.mutateAsync({
      id: template?._id,
      group: group._id,
      description: description.trim(),
      amountCents,
      category,
      splitType: SPLIT_TYPES.EQUAL,
      participants,
      paidBy: [{ userId: payerId, amountCents }],
      frequency,
      interval,
      startDate,
      endDate: endDate || null,
    });
    onClose();
  }

  const blocked =
    !description.trim() || amountCents <= 0 || participants.length === 0 || !payerId ||
    Boolean(preview?.error);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit recurring expense' : 'Add a recurring expense'}
    >
      <form onSubmit={onSubmit} className="max-h-[75vh] space-y-4 overflow-y-auto p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="label" htmlFor="rec-desc">Description</label>
            <input
              id="rec-desc"
              required
              autoFocus
              className="input"
              placeholder="Rent, Internet, Cleaner…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="rec-amount">Amount</label>
            <MoneyInput
              id="rec-amount"
              className="sm:w-36"
              valueCents={amountCents}
              onChangeCents={setAmountCents}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="rec-freq">Repeats</label>
            <select
              id="rec-freq"
              className="input"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
            >
              {FREQUENCY_LIST.map((f) => (
                <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rec-category">Category</label>
            <select
              id="rec-category"
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

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="rec-start">Starts on</label>
            <input
              id="rec-start"
              type="date"
              required
              className="input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="rec-end">Ends on (optional)</label>
            <input
              id="rec-end"
              type="date"
              className="input"
              min={startDate}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div>
          <span className="label">Paid by</span>
          <div className="flex flex-wrap gap-1.5">
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => setPayerId(person.id)}
                className={`chip-tap flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs font-medium transition ${
                  payerId === person.id
                    ? 'border-brand-500 bg-accent-soft text-accent-soft-fg'
                    : 'border-line text-fg-muted hover:bg-hover'
                }`}
              >
                <Avatar user={person} size={22} />
                {person.id === user?.id ? 'You' : person.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="label">Split equally between</span>
          <div className="flex flex-wrap gap-1.5">
            {people.map((person) => {
              const on = participants.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setParticipants(
                      on
                        ? participants.filter((x) => x !== person.id)
                        : [...participants, person.id],
                    )
                  }
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
        </div>

        {preview?.error && <p className="text-sm font-medium text-owe">{preview.error.message}</p>}

        {preview && !preview.error && (
          <div className="rounded-xl bg-sunken p-3 text-sm">
            <p className="font-semibold text-fg">
              {describeSchedule({ frequency, interval, startDate })} ·{' '}
              {formatMoney(preview.monthlyCents)} a month
            </p>
            <ul className="mt-2 space-y-0.5 text-fg-muted">
              {[...preview.shares].map(([id, cents]) => (
                <li key={id} className="flex justify-between">
                  <span>{people.find((p) => p.id === id)?.name ?? 'Someone'}</span>
                  <span className="tabular-nums">{formatMoney(cents)} each time</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-line pt-2 text-xs text-fg-muted">
              {preview.overdue.length > 0 ? (
                <>
                  <b>{preview.overdue.length}</b>{' '}
                  {preview.overdue.length === 1 ? 'expense' : 'expenses'} will be created right
                  away ({preview.overdue.slice(0, 3).map(cycleKey).join(', ')}
                  {preview.overdue.length > 3 ? '…' : ''}), then next on {cycleKey(preview.next)}.
                </>
              ) : (
                <>First expense will be created on {cycleKey(preview.next)}.</>
              )}
            </p>
          </div>
        )}

        <ErrorNote error={save.error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={blocked || save.isPending}>
            {save.isPending ? (
              <Spinner className="border-white/40 border-t-white" />
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Add recurring expense'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
