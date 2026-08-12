import { useState } from 'react';
import { formatMoney } from '@shared/money.js';
import { SPLIT_TYPES } from '@shared/splitEngine.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useDeleteExpense } from '../hooks/queries.js';
import { Avatar, EmptyState, Modal } from './ui.jsx';

const CATEGORY_ICONS = {
  general: '🧾', food: '🍽️', groceries: '🛒', rent: '🏠', utilities: '💡',
  transport: '🚕', entertainment: '🎬', shopping: '🛍️', travel: '✈️', health: '💊', other: '📦',
};

const monthLabel = (date) =>
  new Date(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** Group expenses under month headings, newest first. */
function byMonth(expenses) {
  const groups = [];
  for (const expense of expenses) {
    const label = monthLabel(expense.date);
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(expense);
  }
  return groups;
}

export function ExpenseList({ expenses, onEdit, showGroupName = false }) {
  const { user } = useAuth();
  const [detail, setDetail] = useState(null);

  if (expenses.length === 0) {
    return (
      <EmptyState icon="🧾" title="No expenses yet">
        Add one to start tracking who owes what.
      </EmptyState>
    );
  }

  const idOf = (u) => String(u?._id ?? u?.id ?? u);

  return (
    <>
      {byMonth(expenses).map((month) => (
        <div key={month.label}>
          <h3 className="bg-app/80 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {month.label}
          </h3>
          <ul className="divide-y divide-line-soft">
            {month.items.map((expense) => {
              const myShare = expense.shares.find((s) => idOf(s.user) === user?.id);
              const myPayment = expense.paidBy.find((p) => idOf(p.user) === user?.id);
              const lentCents = (myPayment?.amountCents ?? 0) - (myShare?.amountCents ?? 0);
              const payerNames = expense.paidBy
                .map((p) => (idOf(p.user) === user?.id ? 'You' : p.user.name?.split(' ')[0]))
                .join(', ');

              return (
                <li key={expense._id}>
                  <button
                    type="button"
                    onClick={() => setDetail(expense)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover"
                  >
                    <div className="flex w-10 shrink-0 flex-col items-center">
                      <span className="text-lg" aria-hidden="true">
                        {CATEGORY_ICONS[expense.category] ?? '🧾'}
                      </span>
                      <span className="text-[10px] font-medium uppercase text-fg-subtle">
                        {new Date(expense.date).toLocaleDateString(undefined, {
                          day: 'numeric', month: 'short',
                        })}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-fg">
                        {expense.description}
                        {expense.splitType === SPLIT_TYPES.ITEMIZED && (
                          <span className="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-soft-fg">
                            by dish
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-fg-subtle">
                        {payerNames} paid {formatMoney(expense.amountCents, expense.currency)}
                        {showGroupName && expense.group?.name ? ` · ${expense.group.name}` : ''}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      {lentCents === 0 ? (
                        <span className="text-xs text-fg-subtle">not involved</span>
                      ) : (
                        <>
                          <p className="text-[10px] font-medium uppercase text-fg-subtle">
                            {lentCents > 0 ? 'you lent' : 'you borrowed'}
                          </p>
                          <p
                            className={`text-sm font-semibold tabular-nums ${
                              lentCents > 0 ? 'text-owed' : 'text-owe'
                            }`}
                          >
                            {formatMoney(Math.abs(lentCents), expense.currency)}
                          </p>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <ExpenseDetail
        expense={detail}
        onClose={() => setDetail(null)}
        onEdit={() => {
          const target = detail;
          setDetail(null);
          onEdit?.(target);
        }}
      />
    </>
  );
}

/** Full breakdown of one expense, dish by dish when it was split that way. */
function ExpenseDetail({ expense, onClose, onEdit }) {
  const { user } = useAuth();
  const remove = useDeleteExpense();
  const [confirming, setConfirming] = useState(false);

  if (!expense) return null;
  const idOf = (u) => String(u?._id ?? u?.id ?? u);
  const isItemized = expense.splitType === SPLIT_TYPES.ITEMIZED;

  return (
    <Modal open onClose={onClose} title={expense.description}>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
        <div className="text-center">
          <p className="text-3xl font-bold tabular-nums text-fg">
            {formatMoney(expense.amountCents, expense.currency)}
          </p>
          <p className="mt-0.5 text-sm text-fg-subtle">
            {new Date(expense.date).toLocaleDateString(undefined, {
              weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        </div>

        <section>
          <h4 className="label">Paid by</h4>
          <ul className="space-y-1.5">
            {expense.paidBy.map((p) => (
              <li key={idOf(p.user)} className="flex items-center gap-2.5">
                <Avatar user={p.user} size={28} />
                <span className="flex-1 text-sm text-fg">
                  {idOf(p.user) === user?.id ? 'You' : p.user.name}
                </span>
                <span className="text-sm font-semibold tabular-nums text-fg">
                  {formatMoney(p.amountCents, expense.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {isItemized && expense.items?.length > 0 && (
          <section>
            <h4 className="label">Dishes</h4>
            <ul className="space-y-2 rounded-xl border border-line p-2.5">
              {expense.items.map((item, i) => (
                <li key={i}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-fg">
                      {item.name || `Dish ${i + 1}`}
                      {item.qty > 1 && <span className="text-fg-subtle"> ×{item.qty}</span>}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-fg-muted">
                      {formatMoney(item.priceCents * (item.qty ?? 1), expense.currency)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {item.sharedBy.map((u) => (
                      <span
                        key={idOf(u)}
                        className="flex items-center gap-1 rounded-full bg-sunken py-0.5 pl-0.5 pr-2 text-[11px] text-fg-muted"
                      >
                        <Avatar user={u} size={16} />
                        {u.name?.split(' ')[0] ?? '?'}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <dl className="mt-2 space-y-0.5 text-sm">
              {[
                ['Tax', expense.taxCents],
                ['Tip', expense.tipCents],
                ['Other', expense.otherCents],
                [
                  expense.discountMode === 'percent' && expense.discountBps
                    ? `Discount (${expense.discountBps / 100}%)`
                    : 'Discount',
                  expense.discountCents ? -expense.discountCents : 0,
                ],
              ]
                .filter(([, cents]) => cents)
                .map(([label, cents]) => (
                  <div key={label} className="flex justify-between text-fg-muted">
                    <dt>{label}</dt>
                    <dd className="tabular-nums">
                      {cents < 0 ? '−' : ''}
                      {formatMoney(Math.abs(cents), expense.currency)}
                    </dd>
                  </div>
                ))}
            </dl>
            <p className="mt-1.5 text-xs text-fg-subtle">
              Tax and tip were shared in proportion to what each person ate.
            </p>
          </section>
        )}

        <section>
          <h4 className="label">Who owes what</h4>
          <ul className="space-y-1.5">
            {expense.shares.map((s) => (
              <li key={idOf(s.user)} className="flex items-center gap-2.5">
                <Avatar user={s.user} size={28} />
                <span className="flex-1 text-sm text-fg">
                  {idOf(s.user) === user?.id ? 'You' : s.user.name}
                </span>
                <span className="text-sm font-semibold tabular-nums text-fg">
                  {formatMoney(s.amountCents, expense.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {expense.notes && (
          <section>
            <h4 className="label">Notes</h4>
            <p className="text-sm text-fg-muted">{expense.notes}</p>
          </section>
        )}

        <div className="flex justify-between gap-2 border-t border-line pt-3">
          {confirming ? (
            <>
              <span className="self-center text-sm text-fg-muted">Delete this expense?</span>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
                  Keep
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={remove.isPending}
                  onClick={async () => {
                    await remove.mutateAsync(expense._id);
                    onClose();
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
                Delete
              </button>
              <button type="button" className="btn-primary" onClick={onEdit}>
                Edit
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
