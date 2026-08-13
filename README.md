# Splitwise

A Splitwise clone on the MERN stack, with three things at its heart:

- **Dish-wise splitting** — enter each dish, tick who ate it, add tax/tip/discount, and
  everyone is charged for exactly what they had. Tax and tip are shared *in proportion to
  what each person ate*, not split blindly down the middle. Or **photograph the bill** and
  have the dishes and taxes filled in for you.
- **Simplify debts** — collapse a tangle of who-owes-whom into the fewest payments that
  settle everybody, exactly like the real thing.
- **Recurring expenses** — rent, the internet bill, a cleaner. Due cycles are created
  automatically (including any missed while nobody was looking), and a per-month view nets
  every standing commitment down to the fewest transfers.

Plus the usual: groups, `@username` handles, normal splits (equally, unequally, by
percentage, by shares), multiple payers on one bill, friends, settle-up, and running
balances. It's installable as a PWA and has a dark mode.

## Getting started

```bash
npm install

cp server/.env.example server/.env    # then paste your MongoDB Atlas URI + a JWT secret
npm run dev                           # API on :5000, app on http://localhost:5173
```

`server/.env.example` documents every variable, including how to get an Atlas connection
string and the IP-allowlist step people usually forget.

Want data to look at straight away?

```bash
npm run seed --workspace server
```

That creates two groups: a "Goa Trip" with five expenses (two of them dish-wise, one with two
payers), and a "Flat 402" with three recurring bills whose past months are already backfilled.
Sign in as `aditi@example.com` / `password123` (or rahul@ / sara@) — handles are `@aditi`,
`@rahul`, `@sara`.

### Installable, and dark by default if you are

The production build ships a web manifest and a service worker, so browsers offer to install
it and it opens like an app. The shell is precached and loads offline — but **API responses
are deliberately never cached**. This app is about money, and a cached balance that has since
changed would misrepresent what someone owes; better to fail honestly than to lie quietly.

There's a labelled theme switch at the bottom of the sidebar (and a compact one on the sign-in
screen). It follows your operating system until you touch it, after which your choice sticks;
"Use system setting" hands control back. The class is set by a tiny inline script before first
paint, so there's no flash of the wrong theme on load.

The two palettes are deliberately different in character:

- **Light is warm** — cream paper (`#f7f1e4`) rather than clinical white, with brown-tinted
  text instead of blue-grey. The teal brand sits naturally on cream, and figures read as ink
  on paper.
- **Dark is shades of black** — a `#0a0a0a` page with cards, hovers and borders stepping up
  in small, neutral increments. No blue cast at all.

Both come from one set of semantic tokens — `surface`, `fg`, `line` and friends — rather than
`dark:` variants sprinkled through every component, so the themes can't drift apart. Money
colours shift with the theme too: a deep burnt orange on cream, lifted to a warmer tone on
black so it carries without glowing.

## Security

The app was tested adversarially — forged tokens, NoSQL operator injection, IDOR against
another group's ledger, tampered payloads, brute force, and header/cookie inspection. What's
in place:

- **Auth.** JWT in an httpOnly, SameSite=Lax cookie (Secure in production), bcrypt at 12
  rounds. Forged tokens and `alg: none` downgrades are rejected. Login takes the same time
  whether or not the account exists — bailing out early on an unknown email is enough to
  enumerate who's registered, even with identical error text.
- **Sessions don't expire by default.** You stay signed in until you sign out. The trade is
  worth knowing: nothing can revoke a token that has leaked, so an unlimited session is only
  as safe as the devices it was made on. Set `JWT_EXPIRES_IN` (`30d`, `12h`, …) to time
  sessions out; changing `JWT_SECRET` invalidates every session at once.
- **Stand-ins can't be signed in as.** They hold a random password nobody has, and the login
  route excludes them explicitly rather than relying on that alone. They're also hidden from
  search and friend lookup, since they belong to one group.
- **Injection.** Every request body is parsed by zod, so `{"email": {"$gt": ""}}` is rejected
  as "not a string" before Mongo ever sees it. zod also strips unknown keys, which closes off
  mass assignment. The one regex built from user input has its metacharacters escaped.
- **Access control.** Every group-scoped route checks membership; an outsider gets 403 on
  reads *and* writes. Expense shares are always recomputed server-side, so a client can't
  dictate who owes what, and nobody can name a non-member in an expense or fabricate a
  payment between two people they aren't part of.
- **Rate limiting.** Login is capped per account *per IP* — keyed on both, because flatmates
  share a router and this is an app for flatmates; keying on IP alone would let one person's
  forgotten password lock out the whole house. Sign-ups and general API traffic are capped too.
- **Headers.** helmet sets CSP, `X-Frame-Options`, `nosniff` and HSTS, and drops
  `X-Powered-By`. Framing is denied outright — clickjacking a page with "settle up" buttons
  is a real risk.
- **Limits.** 256KB request bodies (returning 413, not 500), and a ceiling on any single
  amount that keeps sums far below `Number.MAX_SAFE_INTEGER`, where the balance arithmetic
  would silently lose precision.

One caveat for production: `express-rate-limit` defaults to an in-memory store, which on a
serverless host means one counter per warm instance rather than one globally. That still
blunts a naive guessing run, but if it matters, point it at a shared store (Redis, or Upstash
on Vercel) via the `store` option — see `server/src/middleware/rateLimit.js`.

## Deploying to Vercel

The repo is ready to deploy as-is — `api/[...path].js` wraps the same Express app as a
serverless function, and `vercel.json` serves the built client alongside it. No code changes
needed; it's about five minutes of clicking.

### 1. Get your secrets ready

```bash
# A JWT secret — copy the output, you'll paste it in step 4
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

You'll also need your MongoDB Atlas connection string (Atlas → **Connect** → **Drivers**).
Make sure the database name is on the end: `...mongodb.net/splitwise?retryWrites=true&w=majority`.

### 2. Open Atlas to the internet

Atlas → **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`).

This step is not optional. Serverless functions get a different IP on every invocation, so an
allowlist of specific addresses will fail intermittently and confusingly. Your database is
still protected by its username and password.

### 3. Push and import

```bash
git init && git add -A && git commit -m "Splitwise"
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then go to [vercel.com/new](https://vercel.com/new), import the repo, and **leave every build
setting alone** — framework preset "Other" is correct, and `vercel.json` supplies the rest.

### 4. Add the environment variables

Before you hit Deploy, expand **Environment Variables** and add:

| Name | Value |
|---|---|
| `MONGODB_URI` | your Atlas SRV string from step 1 |
| `JWT_SECRET` | the random string from step 1 |
| `GEMINI_API_KEY` | *optional* — a free key from [AI Studio](https://aistudio.google.com/apikey), for reading photographed bills |

Apply them to Production, Preview and Development. If you forget the first two, the deploy
succeeds but every request returns `503 Database unavailable` — add them and redeploy.
Leaving out `GEMINI_API_KEY` is fine: bill scanning falls back to the on-device reader.

### 5. Deploy, then check it

Hit **Deploy**. When it finishes, visit `https://<your-project>.vercel.app/api/health` — it
should return `{"ok":true}`. If it does, the API and database are both wired up correctly.
Then open the site itself and register an account.

### 6. Seed data (optional)

There's no seed step on Vercel — run it from your own machine against the same database:

```bash
# server/.env must hold the same MONGODB_URI
npm run seed --workspace server
```

### If something goes wrong

| Symptom | Cause |
|---|---|
| `503 Database unavailable` | `MONGODB_URI` missing/wrong, or Atlas is blocking the IP — check step 2 |
| Requests hang, then time out | Atlas Network Access not open to `0.0.0.0/0` |
| Login succeeds but you're logged straight out | `JWT_SECRET` not set, or different between deployments |
| Blank page, 404 on a refresh of `/groups/…` | `vercel.json` wasn't picked up — confirm it's committed at the repo root |

Vercel → your project → **Logs** shows the function output, including the connection error
message, which is usually enough to tell which of the above it is.

Three things are handled that otherwise bite on serverless:

- **Connection reuse.** The Mongoose connection promise is cached on `globalThis`, so warm
  invocations share one connection instead of opening a new one per request and exhausting
  the Atlas cap.
- **The pre-parsed body.** Vercel reads and parses the request body before your handler runs,
  which leaves `express.json()` waiting on a stream that will never emit. The handler sets
  body-parser's `_body` flag so it passes through instead of hanging.
- **Cookies behind the proxy.** `trust proxy` is on, so Express sees the original HTTPS
  request and will actually set the `Secure` auth cookie.

`CLIENT_ORIGIN` isn't needed in production — the app and API share an origin, so CORS never
comes into play. Locally they're on different ports, which is why it's set in `.env`.

The function lives at `api/[...path].js` rather than `api/index.js` on purpose: the catch-all
filename lets Vercel's own filesystem routing send every `/api/*` request to it with the URL
intact, instead of depending on a rewrite to preserve the path.

## Tests

```bash
npm test
```

145 tests, no database or network required — the API tests run against an in-memory MongoDB
and the rest are pure functions and component tests. The money and date logic is covered by
property tests that run hundreds of randomised cases looking for a lost paise or a drifting
schedule.

### Mobile

The layout is checked on iPhone SE, iPhone 14, Pixel 7 and iPad mini for three things that
break responsive designs in practice:

- **Nothing overflows the viewport.** Measured per element, cross-checked against
  `scrollWidth` — the thing that actually produces a horizontal scrollbar.
- **Tap targets are finger-sized.** Everything interactive clears a comfortable minimum under
  `pointer: coarse`, so the denser desktop spacing is untouched.
- **The off-canvas menu works** — starts hidden, slides in from the hamburger, closes on the
  backdrop, and the theme switch is reachable inside it.

That sweep caught a genuine bug: the dashboard's two-column grid pushed the page 11px wider
than an iPhone SE, because a grid track won't shrink below its content's min-content width
unless you tell it to (`min-w-0`).

## How it works

### Money is never a float

Every amount is an integer number of paise. `0.1 + 0.2` problems in a bill-splitter mean
balances that never quite reach zero, so floats appear only at the input/display edge.

Leftovers are handed out by the largest-remainder method: ₹10 between three people is
`3.34 / 3.33 / 3.33`, never `3.33 × 3` with a paise quietly lost. It's deterministic, so the
server and the browser always agree.

### One shape for every expense

However an expense was entered, it normalises to two lists that each sum to the total:

```
paidBy: [{ user, amountCents }]     // who put money down
shares: [{ user, amountCents }]     // who owes what
```

Balances, pairwise debts and simplification read only those. `shares` is always recomputed on
the server — a `shares` array sent by a client is ignored, so a tampered request can't
invent a debt.

### Dish-wise, precisely

```
1. each dish's cost is split equally among the people who shared it
2. tax + tip + other − discount is then split in proportion to each
   person's dish subtotal
```

A discount can be entered as a flat amount (₹50 off) or a percentage (25% off), toggled with
the ₹/% switch. A percentage comes off the **dishes**, before tax — so the tax is still
charged on the full menu price, the way a real bill works.

So if your dishes were 40% of the food bill, you pay 40% of the GST. In the seeded dinner
Aditi skips the beer and dessert and owes ₹320.34 of a ₹1,977.30 bill, while the other two
owe ₹828.48 each — and the three add up to the bill exactly.

### Scanning a bill

On the **By dish** tab, *Scan a bill* opens the rear camera. The photo is rotated using its
EXIF flag (or OCR reads a sideways receipt as nothing), scaled to 1600px on the long edge,
and read by whichever engine is available:

| | Engine | Needs | Quality |
|---|---|---|---|
| With `GEMINI_API_KEY` | Gemini, server-side | a free key, no card | good on crumpled thermal bills |
| Without | Tesseract, in your browser | nothing at all | rough; expect to fix rows |

The choice is automatic — the server answers `fallback: "tesseract"` when it has no key or
the call fails, and the browser takes over. Deliberately a `200`, not an error: falling back
is a normal outcome, and a working fallback shouldn't look like a broken app.

**The photo is never stored.** It's read and dropped — not written to the database, to disk
or to a log. With Tesseract it never leaves the device at all.

Two guards, because OCR is wrong sometimes:

- Every scanned dish starts **ticked for everyone**, so a bill the table shared is one tap
  from saved — and the panel says so, because a dish you forget to untick is charged to
  people who didn't eat it.
- The rows are **reconciled against the total printed on the bill**. Drop a line and you get
  *"the bill says ₹1,240 but these rows come to ₹1,190"*. This is the check that catches a
  missed dish, which is the failure OCR actually has — it drops lines far more often than it
  invents them.

Nothing is saved until you press **Add expense**, so a misread costs a correction, never a
wrong balance.

### Recurring expenses

A `RecurringExpense` is a template plus a schedule. It generates ordinary `Expense`
documents, so nothing downstream — balances, pairwise debts, simplification — needs to know
recurring expenses exist at all.

Three things make it trustworthy:

- **Backfill, not skip.** Away for three months means three rents get created, because the
  debt genuinely accrued. `occurrencesUpTo()` walks every missed cycle.
- **Exactly once.** A unique partial index on `(recurring, cycleKey)` means a second attempt
  at the same cycle is a duplicate-key error we swallow, not a second charge. Three flatmates
  opening the app at the same moment cannot double-bill anyone.
- **No cron.** Generation runs on read, so the ledger is current whenever someone looks. No
  scheduler, no always-on worker, nothing to forget to deploy.

Monthly-style series stay anchored to the day they started: 31 Jan → 28 Feb → **31** Mar, not
28 Mar. All the date maths is UTC, so a DST changeover can't shift a bill by a day.

The per-month view converts every commitment to a common unit before netting — a weekly ₹100
is ₹433.33 a month (×52÷12), not ₹400, because "four weeks in a month" quietly loses a month
of money a year. Both sides of each template are re-allocated with largest-remainder so
everything still sums to zero, then the same simplifier runs over it.

### Simplifying debts

`Group.simplifyDebts` (on by default) switches the balances tab between:

- **the raw ledger** — debts as they actually arose, expense by expense
- **the simplified set** — greedy min-cash-flow, repeatedly matching the biggest debtor with
  the biggest creditor. Each transfer zeroes out at least one person, so it never needs more
  than *n−1* payments.

In the seeded group that turns 3 payments into 2, dropping a hop entirely. (Finding the
provably fewest transfers is subset-sum hard; greedy is what Splitwise does and is optimal
for any realistic group.)

## Layout

```
shared/          money.js + splitEngine.js + recurrence.js — pure, dependency-free, imported
                 by BOTH sides so the live preview while you type is the same code the
                 server trusts
server/src/
  models/        User, Group, Expense, Settlement, RecurringExpense
  lib/           balances.js (net, pairwise, simplify), recurring.js, ledger.js
  routes/        auth, users, groups, expenses, settlements, dashboard, recurring
  middleware/    JWT auth + group-membership guards, zod validation, error mapping
client/src/
  components/    ExpenseModal (the five split modes), DishSplit, balances UI, modals
  pages/         Login, Dashboard, GroupPage
```

Auth is a JWT in an httpOnly cookie, so client-side script — including any XSS — can't read
it. Every group-scoped route checks membership before returning a ledger.

## Notes

- Every account has a `@username`. It's how people find each other — "add @rahul" works
  without knowing anyone's email, and tells two Rahuls apart.
- Payers and participants always come from the group's members. An expense outside a group
  has nobody to hold the debt, so the form asks which group first.
- Deleting a recurring expense stops future cycles but keeps the ones already created —
  that money really was owed.
- **People without accounts.** Add a stand-in ("Priya") to a group and they behave like any
  other member in expenses, balances and simplification — they simply can't sign in. They're
  ordinary user records with a flag, which is why nothing downstream needs a special case.
  When the real person joins, tap their chip and link their account: every expense, dish they
  shared, payment and recurring template is repointed and the stand-in removed, so balances
  come out identical. Without that step the history would be stranded and the feature would
  be a trap.
- Anyone in a group can edit or delete any payment in it, and record one between any two
  members. The ledger is shared, so a mistyped payment skews everybody's balance and anybody
  should be able to correct it. Outside a group that stays limited to the two people involved.
- Expenses and settlements are soft-deleted, so a mis-click is recoverable.
- You can't remove someone from a group while their balance is non-zero.
- Editing an expense re-runs the whole split; the original form input is stored so
  re-opening an expense restores exactly what was typed.
