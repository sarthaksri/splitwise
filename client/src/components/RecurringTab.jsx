import { useState } from 'react';
import { formatMoney } from '@shared/money.js';
import { describeSchedule, FREQUENCY_LABELS } from '@shared/recurrence.js';
import {
  useDeleteRecurring,
  useRecurring,
  useRecurringSummary,
  useSaveRecurring,
} from '../hooks/queries.js';
import { Avatar, EmptyState, Money, Spinner, Toggle } from './ui.jsx';
import { RecurringModal } from './RecurringModal.jsx';

/**
 * Standing commitments for a group, and what they net down to per month.
 *
 * The netting view is the recurring counterpart of simplify-debts: instead of
 * six separate monthly obligations flying in different directions, it shows the
 * one or two standing payments that would actually settle them.
 */
export function RecurringTab({ group, people, currentUserId }) {
  const { data, isLoading } = useRecurring(group._id);
  const { data: summary } = useRecurringSummary(group._id);
  const saveRecurring = useSaveRecurring();
  const removeRecurring = useDeleteRecurring();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  if (isLoading) {
    return <div className="card flex justify-center py-12"><Spinner /></div>;
  }

  const templates = data?.recurring ?? [];
  const nameOf = (user, id) => (id === currentUserId ? 'You' : user.name);

  return (
    <div className="space-y-4">
      <section className="card">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
          <h2 className="text-sm font-semibold text-fg">Recurring expenses</h2>
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={() => setAdding(true)}
          >
            + Add
          </button>
        </div>

        {templates.length === 0 ? (
          <EmptyState icon="🔁" title="No recurring expenses">
            Add rent, the internet bill or anything else that repeats, and it'll be created
            automatically each cycle.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {templates.map((t) => {
              const payer = t.paidBy[0]?.user;
              return (
                <li key={t._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken text-base">
                    🔁
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">
                      {t.description}
                      {!t.active && (
                        <span className="ml-1.5 rounded bg-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase text-fg-muted">
                          paused
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-fg-subtle">
                      {t.scheduleLabel ??
                        describeSchedule({
                          frequency: t.frequency,
                          interval: t.interval,
                          startDate: t.startDate,
                        })}
                      {payer ? ` · ${payer.name?.split(' ')[0]} pays` : ''}
                    </p>
                  </div>
                  <span className="font-semibold tabular-nums text-fg">
                    {formatMoney(t.amountCents, group.currency)}
                  </span>
                  <Toggle
                    checked={t.active}
                    onChange={(active) =>
                      saveRecurring.mutate({ id: t._id, active })
                    }
                    label=""
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-compact text-danger-fg hover:bg-danger-soft"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Stop "${t.description}" from recurring? Expenses already created stay.`,
                        )
                      ) {
                        removeRecurring.mutate(t._id);
                      }
                    }}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {summary && summary.items.length > 0 && (
        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-soft px-4 py-2.5">
            <h2 className="min-w-0 text-sm font-semibold text-fg">
              Every month, simplified
            </h2>
            <span className="text-xs text-fg-muted">
              {formatMoney(summary.totalMonthlyCents, group.currency)} / month across{' '}
              {summary.items.length} {summary.items.length === 1 ? 'bill' : 'bills'}
            </span>
          </div>

          {summary.standingPayments.length === 0 ? (
            <EmptyState icon="✅" title="Nothing to transfer">
              These bills already balance out between everyone.
            </EmptyState>
          ) : (
            <>
              <ul className="divide-y divide-line-soft">
                {summary.standingPayments.map((p) => (
                  <li
                    key={`${p.from}-${p.to}`}
                    className="flex flex-wrap items-center gap-2.5 px-4 py-3"
                  >
                    <Avatar user={p.fromUser} size={30} />
                    <span className="text-sm text-fg">
                      <span className="font-semibold">{nameOf(p.fromUser, p.from)}</span>
                      <span className="text-fg-subtle">
                        {' '}
                        {p.from === currentUserId ? 'pay' : 'pays'}{' '}
                      </span>
                      <span className="font-semibold">{nameOf(p.toUser, p.to)}</span>
                    </span>
                    <Avatar user={p.toUser} size={30} />
                    <span className="ml-auto font-semibold tabular-nums text-owe">
                      {formatMoney(p.amountCents, group.currency)}
                      <span className="ml-0.5 text-xs font-normal text-fg-subtle">/mo</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line-soft px-4 py-2.5 text-xs text-fg-muted">
                {summary.items.length} recurring{' '}
                {summary.items.length === 1 ? 'bill nets' : 'bills net'} down to{' '}
                {summary.standingPayments.length} standing{' '}
                {summary.standingPayments.length === 1 ? 'payment' : 'payments'} a month.
                Amounts are averaged per month — a weekly bill counts 52 times a year, not 48.
              </p>
            </>
          )}

          <ul className="border-t border-line-soft px-4 py-2.5">
            {summary.items.map((item) => (
              <li key={item.id} className="flex justify-between py-0.5 text-xs text-fg-muted">
                <span>
                  {item.description}
                  <span className="text-fg-subtle">
                    {' '}
                    · {FREQUENCY_LABELS[item.frequency]?.toLowerCase()}
                  </span>
                </span>
                <span className="tabular-nums">
                  {formatMoney(item.monthlyCents, group.currency)}/mo
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary && summary.perMonthNet.length > 0 && (
        <section className="card">
          <h2 className="border-b border-line-soft px-4 py-2.5 text-sm font-semibold text-fg">
            Monthly position
          </h2>
          <ul className="divide-y divide-line-soft">
            {summary.perMonthNet.map((n) => (
              <li key={n.userId} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar user={n.user} size={30} />
                <span className="flex-1 truncate text-sm text-fg">
                  {nameOf(n.user, n.userId)}
                </span>
                <span className="text-xs text-fg-subtle">
                  {n.amountCents > 0 ? 'is owed' : 'pays out'}
                </span>
                <Money cents={n.amountCents} currency={group.currency} />
                <span className="text-xs text-fg-subtle">/mo</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RecurringModal
        open={adding}
        onClose={() => setAdding(false)}
        group={group}
        people={people}
      />
      <RecurringModal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        group={group}
        people={people}
        template={editing}
      />
    </div>
  );
}
