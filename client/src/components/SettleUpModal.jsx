import { useEffect, useState } from 'react';
import { formatMoney } from '@shared/money.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettleUp } from '../hooks/queries.js';
import { Avatar, ErrorNote, Modal, Spinner } from './ui.jsx';
import { MoneyInput } from './MoneyInput.jsx';

/**
 * Who-pays-whom picker. Declared at module scope on purpose: a component
 * defined inside another component's body is a fresh type on every render, so
 * React tears down and rebuilds the <select> each keystroke — losing focus and
 * dropping changes made against the old node.
 */
function PersonPicker({ heading, value, onChange, roster, labelFor }) {
  if (roster.length <= 2) {
    const chosen = roster.find((p) => String(p.id) === String(value));
    return (
      <div className="flex-1">
        <span className="mb-1 block text-center text-xs font-medium text-fg-subtle">
          {heading}
        </span>
        <p className="text-center text-sm font-semibold text-fg">{labelFor(chosen)}</p>
      </div>
    );
  }
  return (
    <div className="flex-1">
      <span className="mb-1 block text-center text-xs font-medium text-fg-subtle">{heading}</span>
      <select
        className="input text-center"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={heading}
      >
        <option value="" disabled>
          Choose…
        </option>
        {roster.map((p) => (
          <option key={p.id} value={p.id}>
            {labelFor(p)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Record, or correct, a payment between any two people in the group.
 *
 * Both sides are chosen explicitly rather than assumed to involve you: a group
 * ledger is shared, so settling a debt between two other flatmates has to
 * record *their* payment, not one to you.
 *
 * `preset` supplies the direction and the outstanding amount when you arrive
 * from a Settle button, so the common case is a single confirm.
 */
export function SettleUpModal({ open, onClose, preset, group, people = [], payment }) {
  const { user } = useAuth();
  const settle = useSettleUp();
  const isEdit = Boolean(payment);

  const [fromId, setFromId] = useState(null);
  const [toId, setToId] = useState(null);
  const [amountCents, setAmountCents] = useState(0);
  const [suggestedCents, setSuggestedCents] = useState(0);
  const [note, setNote] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const idOf = (u) => String(u?._id ?? u?.id ?? u ?? '');

  useEffect(() => {
    if (!open) return;
    settle.reset();

    if (payment) {
      setFromId(idOf(payment.from));
      setToId(idOf(payment.to));
      setAmountCents(payment.amountCents);
      setSuggestedCents(0);
      setNote(payment.note ?? '');
      setDate(new Date(payment.date).toISOString().slice(0, 10));
      return;
    }

    setFromId(idOf(preset?.fromUser) || null);
    setToId(idOf(preset?.toUser) || null);
    // Prefilled from the debt you clicked, so you usually just confirm.
    setAmountCents(preset?.amountCents ?? 0);
    setSuggestedCents(preset?.amountCents ?? 0);
    setNote('');
    setDate(new Date().toISOString().slice(0, 10));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset, payment]);

  const roster = (
    people.length ? people : [preset?.fromUser, preset?.toUser].filter(Boolean)
  ).map((u) => ({ ...u, id: idOf(u) }));

  const find = (id) => roster.find((p) => p.id === id);
  const from = find(fromId);
  const to = find(toId);
  const label = (p) => (idOf(p) === user?.id ? 'You' : (p?.name ?? 'Someone'));

  async function onSubmit(e) {
    e.preventDefault();
    await settle.mutateAsync({
      id: payment?._id,
      group: group?._id ?? preset?.groupId ?? null,
      from: fromId,
      to: toId,
      amountCents,
      date,
      note,
    });
    onClose();
  }

  const sameParty = Boolean(fromId) && fromId === toId;
  const blocked = !fromId || !toId || sameParty || amountCents <= 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit payment' : 'Record a payment'}
    >
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        <div className="rounded-xl bg-sunken p-4">
          <div className="flex items-center justify-center gap-3">
            <div className="flex flex-col items-center gap-1.5">
              <Avatar user={from} size={44} />
            </div>
            <div className="flex flex-col items-center px-1 text-fg-subtle">
              <span className="text-xs font-medium">pays</span>
              <svg width="40" height="12" viewBox="0 0 40 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M0 6h34M29 1l6 5-6 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Avatar user={to} size={44} />
            </div>
          </div>

          <div className="mt-2.5 flex items-start gap-2">
            <PersonPicker
              heading="From"
              value={fromId}
              onChange={setFromId}
              roster={roster}
              labelFor={label}
            />
            <button
              type="button"
              onClick={() => {
                setFromId(toId);
                setToId(fromId);
              }}
              className="icon-btn mt-5 p-1.5 text-fg-subtle hover:bg-surface hover:text-brand-600"
              aria-label="Swap who pays whom"
              title="Swap direction"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 7h12l-3-3M16 13H4l3 3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <PersonPicker
              heading="To"
              value={toId}
              onChange={setToId}
              roster={roster}
              labelFor={label}
            />
          </div>

          {sameParty && (
            <p className="mt-2 text-center text-xs font-medium text-owe">
              A payment needs two different people.
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="settle-amount">Amount</label>
          <MoneyInput
            id="settle-amount"
            autoFocus
            valueCents={amountCents}
            onChangeCents={setAmountCents}
          />
          {suggestedCents > 0 && amountCents !== suggestedCents && (
            <button
              type="button"
              className="mt-1 text-xs font-semibold text-brand-600 hover:underline"
              onClick={() => setAmountCents(suggestedCents)}
            >
              Settle the full {formatMoney(suggestedCents)}
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="settle-date">Date</label>
            <input
              id="settle-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="settle-note">Note (optional)</label>
            <input
              id="settle-note"
              className="input"
              placeholder="UPI, cash, …"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <ErrorNote error={settle.error} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={blocked || settle.isPending}>
            {settle.isPending ? (
              <Spinner className="border-white/40 border-t-white" />
            ) : isEdit ? (
              'Save changes'
            ) : (
              'Record payment'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
