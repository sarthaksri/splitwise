import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { formatMoney } from '@shared/money.js';
import {
  useAddMember,
  useAddPlaceholder,
  useBalances,
  useDeletePayment,
  useExpenses,
  useGroup,
  useLinkPlaceholder,
  useSettlements,
  useUpdateGroup,
} from '../hooks/queries.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Avatar, EmptyState, ErrorNote, Modal, Money, Spinner, Toggle } from '../components/ui.jsx';
import { ExpenseList } from '../components/ExpenseList.jsx';
import { RecurringTab } from '../components/RecurringTab.jsx';
import { ExpenseModal } from '../components/ExpenseModal.jsx';
import { SettleUpModal } from '../components/SettleUpModal.jsx';

const TABS = [
  { id: 'expenses', label: 'Expenses' },
  { id: 'balances', label: 'Balances' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'activity', label: 'Payments' },
];

export function GroupPage() {
  const { groupId } = useParams();
  const { user } = useAuth();
  const group = useGroup(groupId);
  const balances = useBalances(groupId);
  const expenses = useExpenses({ group: groupId });
  const settlements = useSettlements({ group: groupId });
  const updateGroup = useUpdateGroup(groupId);

  const [tab, setTab] = useState('expenses');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [settle, setSettle] = useState(null);
  const [editingPayment, setEditingPayment] = useState(null);
  const [linking, setLinking] = useState(null);
  const [inviting, setInviting] = useState(false);

  if (group.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (group.error) return <div className="p-6"><ErrorNote error={group.error} /></div>;

  const g = group.data.group;
  const people = g.members.map((m) => ({
    id: m.user._id ?? m.user.id,
    name: m.user.name,
    username: m.user.username,
    avatarColor: m.user.avatarColor,
    isPlaceholder: Boolean(m.user.isPlaceholder),
  }));
  const myNet = balances.data?.net.find((n) => n.userId === user?.id)?.amountCents ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-fg">{g.name}</h1>
            <p className="mt-0.5 text-sm text-fg-muted">
              {myNet === 0
                ? 'You are settled up in this group.'
                : myNet > 0
                  ? `You are owed ${formatMoney(myNet, g.currency)}.`
                  : `You owe ${formatMoney(-myNet, g.currency)}.`}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => setInviting(true)}>
              Add people
            </button>
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              Add an expense
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {people.map((p) =>
            // A stand-in is a button: tapping it offers to link a real account.
            p.isPlaceholder ? (
              <button
                key={p.id}
                type="button"
                onClick={() => setLinking(p)}
                title={`${p.name} has no account — tap to link one`}
                className="chip-tap flex items-center gap-1.5 rounded-full border border-dashed border-line py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-fg-muted transition hover:bg-hover"
              >
                <Avatar user={p} size={20} />
                {p.name}
                <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                  no account
                </span>
              </button>
            ) : (
              <span
                key={p.id}
                className="flex items-center gap-1.5 rounded-full bg-surface py-0.5 pl-0.5 pr-2.5 text-xs font-medium text-fg-muted ring-1 ring-line"
              >
                <Avatar user={p} size={20} />
                {p.id === user?.id ? 'You' : p.name}
              </span>
            ),
          )}
        </div>
      </header>

      <div className="mb-3 flex gap-1 rounded-xl bg-sunken p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              tab === t.id ? 'bg-surface text-accent-soft-fg shadow-sm' : 'text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <div className="card overflow-hidden">
          {expenses.isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : (
            <ExpenseList expenses={expenses.data?.expenses ?? []} onEdit={setEditing} />
          )}
        </div>
      )}

      {tab === 'balances' && (
        <BalancesTab
          report={balances.data}
          loading={balances.isLoading}
          group={g}
          currentUserId={user?.id}
          onToggleSimplify={(value) => updateGroup.mutate({ simplifyDebts: value })}
          toggling={updateGroup.isPending}
          // Record the debt exactly as shown, whoever it is between — settling
          // two other members must not book the payment against you.
          onSettle={(debt) =>
            setSettle({
              fromUser: debt.fromUser,
              toUser: debt.toUser,
              amountCents: debt.amountCents,
              groupId: g._id,
            })
          }
        />
      )}

      {tab === 'recurring' && (
        <RecurringTab group={g} people={people} currentUserId={user?.id} />
      )}

      {tab === 'activity' && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
            <h2 className="text-sm font-semibold text-fg">Payments</h2>
            <button
              type="button"
              className="btn-secondary btn-compact"
              onClick={() => setSettle({ groupId: g._id, amountCents: 0 })}
            >
              + Record a payment
            </button>
          </div>
          <PaymentList
            settlements={settlements.data?.settlements ?? []}
            currentUserId={user?.id}
            currency={g.currency}
            onEdit={setEditingPayment}
          />
        </div>
      )}

      <ExpenseModal open={adding} onClose={() => setAdding(false)} group={g} people={people} />
      <ExpenseModal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        group={g}
        people={people}
        expense={editing}
      />
      <SettleUpModal
        open={Boolean(settle)}
        onClose={() => setSettle(null)}
        preset={settle}
        group={g}
        people={people}
      />
      <SettleUpModal
        open={Boolean(editingPayment)}
        onClose={() => setEditingPayment(null)}
        payment={editingPayment}
        group={g}
        people={people}
      />
      <InviteModal open={inviting} onClose={() => setInviting(false)} groupId={groupId} />
      <LinkPlaceholderModal
        open={Boolean(linking)}
        onClose={() => setLinking(null)}
        groupId={groupId}
        placeholder={linking}
      />
    </div>
  );
}

/** Net positions, plus the payments that would clear them. */
function BalancesTab({ report, loading, group, currentUserId, onToggleSimplify, toggling, onSettle }) {
  if (loading || !report) {
    return <div className="card flex justify-center py-12"><Spinner /></div>;
  }

  const nameOf = (u, id) => (id === currentUserId ? 'You' : u.name);
  const saved = report.pairwise.length - report.simplified.length;

  return (
    <div className="space-y-4">
      <section className="card">
        <h2 className="border-b border-line-soft px-4 py-2.5 text-sm font-semibold text-fg">
          Balances
        </h2>
        {report.net.length === 0 ? (
          <EmptyState icon="🎉" title="Everyone is settled up">
            No outstanding balances in this group.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {report.net.map((entry) => (
              <li key={entry.userId} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar user={entry.user} size={32} />
                <span className="flex-1 truncate text-sm text-fg">
                  {nameOf(entry.user, entry.userId)}
                </span>
                <span className="text-xs text-fg-subtle">
                  {entry.amountCents > 0 ? 'gets back' : 'owes'}
                </span>
                <Money cents={entry.amountCents} currency={group.currency} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line-soft px-4 py-2.5">
          <h2 className="min-w-0 text-sm font-semibold text-fg">
            {report.simplifyEnabled ? 'Suggested payments' : 'Who owes whom'}
          </h2>
          <Toggle
            checked={report.simplifyEnabled}
            onChange={onToggleSimplify}
            disabled={toggling}
            label="Simplify debts"
          />
        </div>

        {report.debts.length === 0 ? (
          <EmptyState icon="✅" title="Nothing to pay">
            Add an expense and the payments that square everyone up will appear here.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line-soft">
              {report.debts.map((debt) => (
                <li
                  key={`${debt.from}-${debt.to}`}
                  className="flex flex-wrap items-center gap-2.5 px-4 py-3"
                >
                  <Avatar user={debt.fromUser} size={30} />
                  <span className="text-sm text-fg">
                    <span className="font-semibold">{nameOf(debt.fromUser, debt.from)}</span>
                    <span className="text-fg-subtle"> {debt.from === currentUserId ? 'owe' : 'owes'} </span>
                    <span className="font-semibold">{nameOf(debt.toUser, debt.to)}</span>
                  </span>
                  <Avatar user={debt.toUser} size={30} />
                  <span className="ml-auto flex items-center gap-2.5">
                    <span className="font-semibold tabular-nums text-owe">
                      {formatMoney(debt.amountCents, group.currency)}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary btn-compact"
                      onClick={() => onSettle(debt)}
                    >
                      Settle
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-line-soft px-4 py-2.5 text-xs text-fg-muted">
              {report.simplifyEnabled ? (
                saved > 0 ? (
                  <>
                    Simplified from {report.pairwise.length} payments down to{' '}
                    {report.simplified.length} — {saved} fewer transfer{saved === 1 ? '' : 's'},
                    same result.
                  </>
                ) : (
                  <>This is already the fewest payments possible.</>
                )
              ) : (
                <>
                  Showing debts exactly as they arose. Turn on <b>Simplify debts</b> to see the
                  fewest payments that settle the group.
                </>
              )}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Payment history. Everyone in the group can edit or delete any payment —
 * the ledger is shared, so a mistyped amount skews everybody's balance and
 * anybody should be able to put it right.
 */
function PaymentList({ settlements, currentUserId, currency, onEdit }) {
  const removePayment = useDeletePayment();
  const [confirming, setConfirming] = useState(null);

  if (settlements.length === 0) {
    return (
      <EmptyState icon="💸" title="No payments yet">
        Settle a balance, or record a payment between any two people in the group.
      </EmptyState>
    );
  }
  const nameOf = (u) => (String(u._id ?? u.id) === currentUserId ? 'You' : u.name);

  return (
    <ul className="divide-y divide-line-soft">
      {settlements.map((s) => (
        <li key={s._id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-base">
            💸
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-fg">
              <b>{nameOf(s.from)}</b> paid <b>{nameOf(s.to)}</b>
            </p>
            <p className="text-xs text-fg-subtle">
              {new Date(s.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
              {s.note ? ` · ${s.note}` : ''}
            </p>
          </div>
          <span className="font-semibold tabular-nums text-fg">
            {formatMoney(s.amountCents, currency)}
          </span>

          {confirming === s._id ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-fg-muted">Delete?</span>
              <button
                type="button"
                className="btn-ghost btn-compact"
                onClick={() => setConfirming(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="btn-danger btn-compact"
                disabled={removePayment.isPending}
                onClick={async () => {
                  await removePayment.mutateAsync(s._id);
                  setConfirming(null);
                }}
              >
                Delete
              </button>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="btn-ghost btn-compact"
                onClick={() => onEdit(s)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn-ghost btn-compact text-danger-fg hover:bg-danger-soft"
                onClick={() => setConfirming(s._id)}
              >
                Delete
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Two ways to add someone: by their account, or as a stand-in for a person who
 * hasn't signed up. The second is the common case for a flatshare where one
 * person keeps the books.
 */
function InviteModal({ open, onClose, groupId }) {
  const addMember = useAddMember(groupId);
  const addPlaceholder = useAddPlaceholder(groupId);
  const [mode, setMode] = useState('account');
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');

  const busy = addMember.isPending || addPlaceholder.isPending;
  const done = mode === 'account' ? addMember.isSuccess : addPlaceholder.isSuccess;

  function switchMode(next) {
    setMode(next);
    addMember.reset();
    addPlaceholder.reset();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add someone to the group">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (mode === 'account') {
            await addMember.mutateAsync({ handle: handle.trim() });
            setHandle('');
          } else {
            await addPlaceholder.mutateAsync({ name: name.trim() });
            setName('');
          }
        }}
        className="space-y-4 p-5"
      >
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
          {[
            ['account', 'They have an account'],
            ['placeholder', "They don't"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => switchMode(value)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                mode === value
                  ? 'bg-surface text-accent-soft-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'account' ? (
          <div>
            <label className="label" htmlFor="invite-email">Username or email</label>
            <input
              id="invite-email"
              required
              autoFocus
              className="input"
              placeholder="@rahul"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Ask them for their @username.
            </p>
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="invite-name">Their name</label>
            <input
              id="invite-name"
              required
              autoFocus
              className="input"
              placeholder="Priya"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Splits and balances work exactly as normal — they just can't sign in. When
              they do join, you can hand their whole history over to their new account.
            </p>
          </div>
        )}

        {done && !busy && (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-soft-fg">
            Added them.
          </p>
        )}
        <ErrorNote error={addMember.error ?? addPlaceholder.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Done</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner className="border-white/40 border-t-white" /> : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Hand a stand-in's expenses to the real account once they've signed up. */
function LinkPlaceholderModal({ open, onClose, groupId, placeholder }) {
  const link = useLinkPlaceholder(groupId);
  const [handle, setHandle] = useState('');

  useEffect(() => {
    if (open) {
      setHandle('');
      link.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placeholder]);

  if (!placeholder) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Link ${placeholder.name} to an account`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await link.mutateAsync({ placeholderId: placeholder.id, handle: handle.trim() });
          onClose();
        }}
        className="space-y-4 p-5"
      >
        <p className="text-sm text-fg-muted">
          Everything recorded against <b>{placeholder.name}</b> — expenses, dishes they
          shared and payments — moves to the account you name. Balances don't change.
        </p>
        <div>
          <label className="label" htmlFor="link-handle">Their username or email</label>
          <input
            id="link-handle"
            required
            autoFocus
            className="input"
            placeholder="@priya"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </div>
        <ErrorNote error={link.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={link.isPending}>
            {link.isPending ? <Spinner className="border-white/40 border-t-white" /> : 'Link account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
