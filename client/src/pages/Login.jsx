import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api/client.js';
import { ErrorNote, Spinner } from '../components/ui.jsx';
import { ThemeToggle } from '../components/ThemeToggle.jsx';

/** Shared shell for the two auth screens. */
function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="relative flex min-h-full items-center justify-center bg-app px-4 py-12">
      <ThemeToggle compact className="absolute right-4 top-4" />
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-brand-500 text-2xl">
            🧾
          </div>
          <h1 className="text-2xl font-bold text-fg">{title}</h1>
          <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
        </div>
        <div className="card p-6">{children}</div>
        <p className="mt-5 text-center text-sm text-fg-muted">{footer}</p>
      </div>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(form.email, form.password);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to settle up"
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-semibold text-brand-600 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="input"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        <ErrorNote error={error} />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? <Spinner className="border-white/40 border-t-white" /> : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', username: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [handleCheck, setHandleCheck] = useState(null);

  // Check the handle as they type, so a clash surfaces before they submit.
  useEffect(() => {
    const username = form.username.trim().replace(/^@/, '');
    if (username.length < 3) {
      setHandleCheck(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      api
        .get(`/auth/username-available?username=${encodeURIComponent(username)}`)
        .then(setHandleCheck)
        .catch(() => setHandleCheck(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [form.username]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        name: form.name,
        username: form.username.trim().replace(/^@/, ''),
        email: form.email,
        password: form.password,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Split bills without the spreadsheet"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="label" htmlFor="name">Your name</label>
          <input
            id="name"
            required
            autoComplete="name"
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-username">Username</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
              @
            </span>
            <input
              id="reg-username"
              required
              autoComplete="username"
              className="input pl-7 lowercase"
              placeholder="aditi"
              value={form.username}
              onChange={(e) =>
                setForm({ ...form, username: e.target.value.toLowerCase().replace(/\s/g, '') })
              }
            />
          </div>
          <p
            className={`mt-1 text-xs ${
              handleCheck && !handleCheck.available ? 'text-owe' : 'text-fg-subtle'
            }`}
          >
            {handleCheck
              ? (handleCheck.reason ?? `@${form.username} is available`)
              : 'How friends find you when they add you to a group.'}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="reg-email">Email</label>
          <input
            id="reg-email"
            type="email"
            required
            autoComplete="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-password">Password</label>
          <input
            id="reg-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="input"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <p className="mt-1 text-xs text-fg-subtle">At least 8 characters.</p>
        </div>
        <ErrorNote error={error} />
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={busy || (handleCheck ? !handleCheck.available : false)}
        >
          {busy ? <Spinner className="border-white/40 border-t-white" /> : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}
