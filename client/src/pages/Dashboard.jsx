import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney } from '@shared/money.js';
import { useSummary } from '../hooks/queries.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Avatar, EmptyState, ErrorNote, Money, Spinner } from '../components/ui.jsx';
import { ExpenseModal } from '../components/ExpenseModal.jsx';
import { SettleUpModal } from '../components/SettleUpModal.jsx';
import { AddFriendModal } from '../components/AddFriendModal.jsx';

function StatCard({ label, cents, tone }) {
  const toneClass =
    tone === 'owed' ? 'text-owed' : tone === 'owe' ? 'text-owe' : 'text-fg';
  return (
    <div className="card px-4 py-3.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${toneClass}`}>
        {formatMoney(Math.abs(cents))}
      </p>
    </div>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const { data, isLoading, error } = useSummary();
  const [addingExpense, setAddingExpense] = useState(false);
  const [settleWith, setSettleWith] = useState(null);
  const [addingFriend, setAddingFriend] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (error) return <div className="p-6"><ErrorNote error={error} /></div>;

  const { netTotalCents, owedToMeCents, iOweCents, friends, groups } = data;

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Dashboard</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            {netTotalCents === 0
              ? 'You are all settled up.'
              : netTotalCents > 0
                ? `Overall, you are owed ${formatMoney(netTotalCents)}.`
                : `Overall, you owe ${formatMoney(-netTotalCents)}.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => setAddingFriend(true)}>
            Add a friend
          </button>
          <button type="button" className="btn-primary" onClick={() => setAddingExpense(true)}>
            Add an expense
          </button>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total balance" cents={netTotalCents} tone={netTotalCents >= 0 ? 'owed' : 'owe'} />
        <StatCard label="You are owed" cents={owedToMeCents} tone="owed" />
        <StatCard label="You owe" cents={iOweCents} tone="owe" />
      </div>

      {/* min-w-0 on the columns: a grid track refuses to shrink below its
          content's min-content width by default, which pushes the whole page
          wider than the phone on a narrow screen. */}
      <div className="grid gap-6 lg:grid-cols-2 [&>section]:min-w-0">
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Your groups
          </h2>
          <div className="card divide-y divide-line-soft">
            {groups.length === 0 ? (
              <EmptyState icon="👥" title="No groups yet">
                Create a group from the sidebar to split a trip, a flat or a dinner.
              </EmptyState>
            ) : (
              groups.map((group) => (
                <Link
                  key={group.id}
                  to={`/groups/${group.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
                >
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-sunken text-base">
                    {{ trip: '✈️', home: '🏠', couple: '💑' }[group.type] ?? '📁'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">{group.name}</p>
                    <p className="text-xs text-fg-subtle">
                      {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
                    </p>
                  </div>
                  <div className="text-right">
                    {group.myBalanceCents === 0 ? (
                      <span className="text-xs text-fg-subtle">settled up</span>
                    ) : (
                      <>
                        <p className="text-xs text-fg-subtle">
                          {group.myBalanceCents > 0 ? 'you are owed' : 'you owe'}
                        </p>
                        <Money cents={group.myBalanceCents} currency={group.currency} />
                      </>
                    )}
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Friends
          </h2>
          <div className="card divide-y divide-line-soft">
            {friends.length === 0 ? (
              <EmptyState icon="🤝" title="Nothing outstanding">
                When you share an expense with someone, your balance with them shows up here.
              </EmptyState>
            ) : (
              friends.map((friend) => (
                <div key={friend.user.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar user={friend.user} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-fg">
                      {friend.user.name}
                      {friend.user.username && (
                        <span className="ml-1 text-xs font-normal text-fg-subtle">
                          @{friend.user.username}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-fg-subtle">
                      {friend.amountCents > 0 ? 'owes you' : 'you owe'}
                    </p>
                  </div>
                  <Money cents={friend.amountCents} />
                  <button
                    type="button"
                    className="btn-secondary btn-compact"
                    onClick={() =>
                      setSettleWith(
                        // Negative means I owe them, so the money flows my way out.
                        friend.amountCents < 0
                          ? { fromUser: user, toUser: friend.user, amountCents: -friend.amountCents }
                          : { fromUser: friend.user, toUser: user, amountCents: friend.amountCents },
                      )
                    }
                  >
                    Settle
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <ExpenseModal open={addingExpense} onClose={() => setAddingExpense(false)} />
      <AddFriendModal open={addingFriend} onClose={() => setAddingFriend(false)} />
      <SettleUpModal
        open={Boolean(settleWith)}
        onClose={() => setSettleWith(null)}
        preset={settleWith}
      />
    </div>
  );
}
