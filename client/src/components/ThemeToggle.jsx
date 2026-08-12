import { useTheme } from '../context/ThemeContext.jsx';

const SunIcon = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
    <circle cx="10" cy="10" r="3.4" />
    <path
      d="M10 2v1.6M10 16.4V18M18 10h-1.6M3.6 10H2M15.7 4.3l-1.1 1.1M5.4 14.6l-1.1 1.1M15.7 15.7l-1.1-1.1M5.4 5.4L4.3 4.3"
      strokeLinecap="round"
    />
  </svg>
);

const MoonIcon = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
    <path d="M16.5 11.6A7 7 0 0 1 8.4 3.5a7 7 0 1 0 8.1 8.1Z" strokeLinejoin="round" />
  </svg>
);

/**
 * Light/dark switch.
 *
 * The sidebar gets the full labelled row — a bare icon is easy to miss, and a
 * theme switch is something people go looking for. The auth screens use the
 * compact icon, where there's no room for a label.
 */
export function ThemeToggle({ className = '', compact = false }) {
  const { isDark, theme, toggle, setTheme } = useTheme();

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggle}
        className={`rounded-lg border border-line bg-surface p-2 text-fg-muted transition-colors hover:bg-hover hover:text-fg ${className}`}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <SunIcon width="18" height="18" /> : <MoonIcon width="18" height="18" />}
      </button>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        onClick={toggle}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium
                   text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        <span className="shrink-0">
          {isDark ? <SunIcon width="17" height="17" /> : <MoonIcon width="17" height="17" />}
        </span>
        <span className="flex-1 text-left">{isDark ? 'Dark mode' : 'Light mode'}</span>
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            isDark ? 'bg-brand-500' : 'bg-line'
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-knob shadow transition-transform ${
              isDark ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
      </button>

      {/* Only worth offering once you've overridden it. */}
      {theme !== 'system' && (
        <button
          type="button"
          onClick={() => setTheme('system')}
          className="mt-0.5 w-full px-2 text-left text-[11px] text-fg-subtle hover:text-fg-muted"
        >
          Use system setting
        </button>
      )}
    </div>
  );
}
