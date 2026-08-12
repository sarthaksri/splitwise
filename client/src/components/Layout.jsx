import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useGroups } from '../hooks/queries.js';
import { Avatar, Money } from './ui.jsx';
import { CreateGroupModal } from './CreateGroupModal.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';

const navLinkClass = ({ isActive }) =>
  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-accent-soft text-accent-soft-fg' : 'text-fg-muted hover:bg-hover'
  }`;

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { data } = useGroups();
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const groups = data?.groups ?? [];

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-surface
                    transition-transform lg:static lg:translate-x-0 ${
                      menuOpen ? 'translate-x-0' : '-translate-x-full'
                    }`}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
          <span className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-500 text-base">
            🧾
          </span>
          <span className="text-lg font-bold text-fg">Splitwise</span>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <NavLink to="/" className={navLinkClass} onClick={() => setMenuOpen(false)} end>
            <span aria-hidden="true">🏠</span> Dashboard
          </NavLink>

          <div className="mt-5 mb-1 flex items-center justify-between px-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Groups
            </h2>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="icon-btn p-0.5 text-fg-subtle hover:bg-hover hover:text-brand-600"
              aria-label="Create a group"
              title="Create a group"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {groups.length === 0 ? (
            <p className="px-3 py-2 text-xs text-fg-subtle">
              No groups yet — create one to start splitting.
            </p>
          ) : (
            groups.map((group) => (
              <NavLink
                key={group._id}
                to={`/groups/${group._id}`}
                className={navLinkClass}
                onClick={() => setMenuOpen(false)}
              >
                <span className="flex-1 truncate">{group.name}</span>
                {group.myBalanceCents !== 0 && (
                  <Money cents={group.myBalanceCents} currency={group.currency} className="text-xs" />
                )}
              </NavLink>
            ))
          )}
        </nav>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <Avatar user={user} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-fg">{user?.name}</p>
              <p className="truncate text-xs text-fg-subtle">
                {user?.username ? `@${user.username}` : user?.email}
              </p>
            </div>
          </div>
          <ThemeToggle className="mt-1" />
          <button type="button" onClick={onLogout} className="btn-ghost mt-0.5 w-full justify-start">
            Sign out
          </button>
        </div>
      </aside>

      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-scrim lg:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="icon-btn p-1.5 text-fg-muted hover:bg-hover"
            aria-label="Open menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />
            </svg>
          </button>
          <span className="font-bold text-fg">Splitwise</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CreateGroupModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
