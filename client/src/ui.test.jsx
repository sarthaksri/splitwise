/**
 * Smoke tests for the screens that carry real logic.
 *
 * These mount the actual components against realistic API payloads, which
 * catches the class of breakage a production build cannot: bad imports,
 * undefined field access, and a preview that disagrees with the server.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.jsx';
import { ExpenseModal } from './components/ExpenseModal.jsx';
import { ExpenseList } from './components/ExpenseList.jsx';
import { AuthProvider } from './context/AuthContext.jsx';

const ME = {
  id: 'u1',
  name: 'Aditi Sharma',
  username: 'aditi',
  email: 'aditi@example.com',
  avatarColor: '#1cc29f',
};
const RAHUL = { id: 'u2', name: 'Rahul Verma', username: 'rahul', avatarColor: '#ff652f' };
const SARA = { id: 'u3', name: 'Sara Khan', username: 'sara', avatarColor: '#3fa9f5' };
const PEOPLE = [ME, RAHUL, SARA];

/** A group as the API returns it, used when the modal needs members. */
const GROUP = {
  _id: 'g1',
  name: 'Flat 402',
  currency: 'INR',
  members: PEOPLE.map((p) => ({ user: { ...p, _id: p.id } })),
};

const SUMMARY = {
  netTotalCents: 25042,
  owedToMeCents: 25042,
  iOweCents: 0,
  friends: [{ user: RAHUL, amountCents: 12966 }, { user: SARA, amountCents: 12076 }],
  groups: [
    { id: 'g1', name: 'Goa Trip', type: 'trip', currency: 'INR', memberCount: 3, myBalanceCents: 25042 },
  ],
};

/** Route fetches to canned payloads so the components see realistic data. */
function mockApi(routes) {
  globalThis.fetch = vi.fn(async (url) => {
    const path = String(url).replace('/api', '');
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'nope' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(routes[key]) };
  });
}

function renderWithProviders(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApi({
    '/auth/me': { user: ME },
    '/dashboard/summary': SUMMARY,
    '/users/friends': { friends: [RAHUL, SARA] },
    '/groups': { groups: [GROUP] },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Dashboard', () => {
  it('renders the totals and the per-friend breakdown', async () => {
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('Goa Trip')).toBeTruthy();
    expect(screen.getByText('Rahul Verma')).toBeTruthy();
    // ₹250.42 owed to me, formatted for en-IN
    expect(screen.getAllByText(/250\.42/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Overall, you are owed/)).toBeTruthy();
    expect(screen.getAllByText('owes you').length).toBe(2);
  });
});

describe('ExpenseModal', () => {
  const open = (props = {}) =>
    renderWithProviders(
      <ExpenseModal open onClose={() => {}} group={GROUP} people={PEOPLE} {...props} />,
    );

  it('previews an equal split live as you type', async () => {
    open();
    await screen.findByLabelText('Description');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Villa' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '900' } });

    // 900 split three ways shows up immediately, without a round trip.
    const preview = screen.getByText('Who owes what').closest('div');
    expect(within(preview).getAllByText(/300\.00/).length).toBe(3);
  });

  it('shows a specific error instead of letting a bad split through', async () => {
    open();
    await screen.findByLabelText('Description');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Percentages' }));

    // Nothing entered yet: say so, rather than complain about arithmetic.
    expect(screen.getByText(/Enter a percentage for at least one person/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add expense' }).disabled).toBe(true);

    // Now a partial split, which is arithmetically wrong — a different message.
    const percentFields = screen.getAllByRole('spinbutton');
    fireEvent.change(percentFields[0], { target: { value: '40' } });
    expect(screen.getByText(/add up to 40%, they must total 100%/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add expense' }).disabled).toBe(true);

    // Completing it to 100% clears the error and unblocks the form.
    fireEvent.change(percentFields[1], { target: { value: '60' } });
    expect(screen.queryByText(/must total 100%/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add expense' }).disabled).toBe(false);
  });

  it('splits a bill dish by dish and spreads the tax proportionally', async () => {
    open();
    await screen.findByLabelText('Description');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Dinner' } });
    fireEvent.click(screen.getByRole('button', { name: 'By dish' }));

    // One dish everyone shares…
    fireEvent.change(screen.getByPlaceholderText('Dish 1'), { target: { value: 'Curry' } });
    const priceInputs = screen.getAllByPlaceholderText('Price');
    fireEvent.change(priceInputs[0], { target: { value: '600' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Everyone' })[0]);

    // …and a dessert only Rahul and Sara had.
    fireEvent.click(screen.getByRole('button', { name: '+ Add a dish' }));
    fireEvent.change(screen.getByPlaceholderText('Dish 2'), { target: { value: 'Bebinca' } });
    fireEvent.change(screen.getAllByPlaceholderText('Price')[1], { target: { value: '300' } });
    const dish2 = screen.getByPlaceholderText('Dish 2').closest('div.rounded-xl');
    fireEvent.click(within(dish2).getByRole('button', { name: /Rahul/ }));
    fireEvent.click(within(dish2).getByRole('button', { name: /Sara/ }));

    fireEvent.change(screen.getByLabelText('Tax / GST'), { target: { value: '90' } });

    // Aditi: 200 of the 900 food -> 200 + 2/9 of the 90 tax = 220
    // Rahul & Sara: 350 each + 35 tax = 385 each.  Total 990.
    const preview = screen.getByText('Who owes what').closest('div');
    expect(within(preview).getByText(/^₹220\.00$/)).toBeTruthy();
    expect(within(preview).getAllByText(/^₹385\.00$/).length).toBe(2);
    expect(within(preview).getAllByText(/990\.00/).length).toBeGreaterThan(0);
  });

  it('offers every group member as a payer when opened from the dashboard', async () => {
    // Regression: with no group passed, the modal used to offer only yourself,
    // so a second payer could never be named.
    renderWithProviders(<ExpenseModal open onClose={() => {}} />);
    await screen.findByLabelText('Description');

    // It asks which group, then draws the people from that group.
    expect(screen.getByLabelText('Group')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Multiple people paid' }));

    const payerBlock = screen.getByText('Paid by').closest('div').parentElement;
    expect(within(payerBlock).getByText('Rahul Verma')).toBeTruthy();
    expect(within(payerBlock).getByText('Sara Khan')).toBeTruthy();
  });

  it('lets two people pay different amounts', async () => {
    open();
    await screen.findByLabelText('Description');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Cab' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '210' } });
    fireEvent.click(screen.getByRole('button', { name: 'Multiple people paid' }));

    const payerBlock = screen.getByText('Paid by').closest('div').parentElement;
    const amounts = within(payerBlock).getAllByPlaceholderText('0.00');
    fireEvent.change(amounts[0], { target: { value: '150' } });
    fireEvent.change(amounts[1], { target: { value: '60' } });

    expect(screen.getByText('Payments add up ✓')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add expense' }).disabled).toBe(false);
  });

  it('refuses to submit while a dish has nobody assigned', async () => {
    open();
    await screen.findByLabelText('Description');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Lunch' } });
    fireEvent.click(screen.getByRole('button', { name: 'By dish' }));
    fireEvent.change(screen.getAllByPlaceholderText('Price')[0], { target: { value: '500' } });

    expect(screen.getByText('Pick who shared this dish.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add expense' }).disabled).toBe(true);
  });
});

describe('ExpenseList', () => {
  const EXPENSE = {
    _id: 'e1',
    description: 'Dinner at the Wharf',
    amountCents: 197730,
    currency: 'INR',
    date: '2026-08-01T00:00:00.000Z',
    category: 'food',
    splitType: 'ITEMIZED',
    paidBy: [{ user: RAHUL, amountCents: 197730 }],
    shares: [
      { user: { ...ME, _id: 'u1' }, amountCents: 32034 },
      { user: { ...RAHUL, _id: 'u2' }, amountCents: 82848 },
      { user: { ...SARA, _id: 'u3' }, amountCents: 82848 },
    ],
    items: [{ name: 'Beer', priceCents: 22000, qty: 3, sharedBy: [{ ...RAHUL, _id: 'u2' }] }],
    taxCents: 8730,
    tipCents: 10000,
  };

  it('flags a dish-wise expense and shows what I borrowed', async () => {
    renderWithProviders(<ExpenseList expenses={[EXPENSE]} onEdit={() => {}} />);
    expect(await screen.findByText('by dish')).toBeTruthy();
    expect(screen.getByText('you borrowed')).toBeTruthy();
    expect(screen.getByText(/320\.34/)).toBeTruthy();
  });

  it('opens a full breakdown when an expense is clicked', async () => {
    renderWithProviders(<ExpenseList expenses={[EXPENSE]} onEdit={() => {}} />);
    fireEvent.click(await screen.findByText('Dinner at the Wharf'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Dishes')).toBeTruthy();
    expect(within(dialog).getByText('Beer')).toBeTruthy();
    expect(within(dialog).getByText(/shared in proportion/)).toBeTruthy();
  });
});
