import { useEffect } from 'react';
import { formatMoney } from '@shared/money.js';

/** Circular initial-based avatar, coloured per user. */
export function Avatar({ user, size = 36, className = '' }) {
  const initials = (user?.name ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: user?.avatarColor ?? '#94a3b8',
        fontSize: size * 0.38,
      }}
      title={user?.username ? `${user.name} (@${user.username})` : user?.name}
    >
      {initials}
    </span>
  );
}

/** Money in green when it's coming to you, orange when it's going out. */
export function Money({ cents, currency = 'INR', className = '', neutral = false }) {
  const tone = neutral
    ? 'text-fg'
    : cents > 0
      ? 'text-owed'
      : cents < 0
        ? 'text-owe'
        : 'text-fg-muted';
  return <span className={`font-semibold tabular-nums ${tone} ${className}`}>
    {formatMoney(Math.abs(cents), currency)}
  </span>;
}

export function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block size-5 animate-spin rounded-full border-2 border-line border-t-brand-500 ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function ErrorNote({ error, className = '' }) {
  if (!error) return null;
  return (
    <p className={`rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg ${className}`} role="alert">
      {error.message ?? String(error)}
    </p>
  );
}

export function EmptyState({ icon = '📋', title, children, action }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="text-4xl">{icon}</div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <p className="max-w-sm text-sm text-fg-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Accessible modal: closes on Escape, locks background scroll. */
export function Modal({ open, onClose, title, children, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 sm:items-center">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl bg-surface shadow-xl`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn p-1.5 text-fg-subtle hover:bg-hover hover:text-fg"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Small on/off switch used for the group's simplify-debts setting. */
export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm font-medium
                 text-fg disabled:opacity-50"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand-500' : 'bg-line'
        }`}
      >
        {/* 36px track − 16px knob − 2×2px inset = 16px of travel. */}
        <span
          className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-knob shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}
