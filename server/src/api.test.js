import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from './app.js';

let mongo;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';
  process.env.NODE_ENV = 'test';
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

/** Register a user and return an agent that keeps their auth cookie. */
async function signUp(name) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({
    name,
    username: name.toLowerCase(),
    email: `${name.toLowerCase()}@example.com`,
    password: 'password123',
  });
  expect(res.status).toBe(201);
  return { agent, user: res.body.user };
}

describe('auth', () => {
  it('registers, identifies and logs out a user', async () => {
    const { agent, user } = await signUp('Aditi');
    expect(user.email).toBe('aditi@example.com');
    expect(user).not.toHaveProperty('passwordHash');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a duplicate email and a bad password', async () => {
    await signUp('Aditi');
    const dupe = await request(app).post('/api/auth/register').send({
      name: 'Other',
      username: 'other',
      email: 'aditi@example.com',
      password: 'password123',
    });
    expect(dupe.status).toBe(409);

    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email: 'aditi@example.com', password: 'wrongpassword' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('Incorrect username/email or password');
  });

  it('signs in with a username as well as an email', async () => {
    await signUp('Aditi');

    for (const [label, identifier] of [
      ['username', 'aditi'],
      ['@username', '@aditi'],
      ['email', 'aditi@example.com'],
      ['mixed case', 'ADITI'],
      ['padded', '  aditi  '],
    ]) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ identifier, password: 'password123' });
      expect(res.status, `${label} should sign in`).toBe(200);
      expect(res.body.user.username).toBe('aditi');
    }
  });

  it('still accepts the old `email` field, so older clients keep working', async () => {
    await signUp('Aditi');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'aditi@example.com', password: 'password123' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password and an unknown handle the same way', async () => {
    await signUp('Aditi');
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'aditi', password: 'nope' });
    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'ghost', password: 'nope' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical text, so this can't be used to discover who has an account.
    expect(wrongPassword.body.error).toBe(noSuchUser.body.error);
    expect(wrongPassword.body.error).toMatch(/username\/email or password/);
  });

  it('asks for a handle when none is given', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username or email/i);
  });

  it('refuses short passwords and blocks anonymous access', async () => {
    const short = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', username: 'xx', email: 'x@example.com', password: 'abc' });
    expect(short.status).toBe(400);
    expect((await request(app).get('/api/groups')).status).toBe(401);
  });
});

describe('CORS', () => {
  // Regression: production rejected its own login form. Browsers send Origin on
  // same-origin POSTs too, and the allowlist only knew about localhost.
  it('accepts a same-origin request on any host, with no configuration', async () => {
    for (const host of ['splitwise.sarthaksri.xyz', 'my-app-git-abc.vercel.app']) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', `https://${host}`)
        .set('X-Forwarded-Host', host)
        .send({ identifier: 'nobody', password: 'password123' });

      // 401 = it reached the login handler. 500 would mean CORS threw.
      expect(res.status, `${host} should reach the app`).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe(`https://${host}`);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  it('still allows the configured dev origin across ports', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .set('Host', 'localhost:5000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('refuses a hostile origin by withholding the header, not by erroring', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', 'splitwise.sarthaksri.xyz')
      .send({ identifier: 'nobody', password: 'password123' });

    // No CORS header means the browser blocks reading the response, which is
    // the correct outcome — and not a 500.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.status).not.toBe(500);
  });

  it('allows requests with no Origin at all (curl, uptime probes)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('usernames', () => {
  it('gives every account a handle and returns it with the user', async () => {
    const { user } = await signUp('Aditi');
    expect(user.username).toBe('aditi');
  });

  it('rejects a taken or malformed username', async () => {
    await signUp('Aditi');

    const taken = await request(app).post('/api/auth/register').send({
      name: 'Someone Else',
      username: 'Aditi', // different case, same handle
      email: 'else@example.com',
      password: 'password123',
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/@aditi is already taken/);

    const malformed = await request(app).post('/api/auth/register').send({
      name: 'Bad',
      username: 'no spaces!',
      email: 'bad@example.com',
      password: 'password123',
    });
    expect(malformed.status).toBe(400);
  });

  it('reports availability for the sign-up form', async () => {
    const { agent } = await signUp('Aditi');
    const free = await agent.get('/api/auth/username-available?username=rahul');
    expect(free.body.available).toBe(true);

    const used = await agent.get('/api/auth/username-available?username=@aditi');
    expect(used.body.available).toBe(false);
    expect(used.body.reason).toMatch(/already taken/);

    const bad = await agent.get('/api/auth/username-available?username=a');
    expect(bad.body.available).toBe(false);
  });

  it('adds a friend by username or by email', async () => {
    const aditi = await signUp('Aditi');
    await signUp('Rahul');
    await signUp('Sara');

    const byHandle = await aditi.agent.post('/api/users/friends').send({ handle: '@rahul' });
    expect(byHandle.status).toBe(201);
    expect(byHandle.body.friend.username).toBe('rahul');

    const byEmail = await aditi.agent
      .post('/api/users/friends')
      .send({ handle: 'sara@example.com' });
    expect(byEmail.status).toBe(201);

    const missing = await aditi.agent.post('/api/users/friends').send({ handle: '@nobody' });
    expect(missing.status).toBe(404);
  });

  it('finds people by handle and adds them to a group', async () => {
    const aditi = await signUp('Aditi');
    await signUp('Rahul');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Flat' });

    const found = await aditi.agent.get('/api/users/search?q=@rah');
    expect(found.body.users[0].username).toBe('rahul');

    const added = await aditi.agent
      .post(`/api/groups/${body.group._id}/members`)
      .send({ handle: 'rahul' });
    expect(added.status).toBe(201);
    expect(added.body.group.members).toHaveLength(2);
    // members come back with handles so the UI can tell two Rahuls apart
    expect(added.body.group.members.map((m) => m.user.username)).toContain('rahul');
  });
});

describe('groups', () => {
  it('creates a group with members and lists it', async () => {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');

    const created = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Goa Trip', type: 'trip', memberIds: [rahul.user.id] });
    expect(created.status).toBe(201);
    expect(created.body.group.members).toHaveLength(2);
    expect(created.body.group.simplifyDebts).toBe(true);

    const mine = await rahul.agent.get('/api/groups');
    expect(mine.body.groups.map((g) => g.name)).toContain('Goa Trip');
  });

  it('hides a group from people who are not in it', async () => {
    const aditi = await signUp('Aditi');
    const mallory = await signUp('Mallory');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Private' });

    expect((await mallory.agent.get(`/api/groups/${body.group._id}`)).status).toBe(403);
    expect((await mallory.agent.get(`/api/groups/${body.group._id}/balances`)).status).toBe(403);
  });
});

describe('removing people from a group', () => {
  async function trio() {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');
    const sara = await signUp('Sara');
    const { body } = await aditi.agent.post('/api/groups').send({
      name: 'Flat 402',
      memberIds: [rahul.user.id, sara.user.id],
    });
    return { aditi, rahul, sara, groupId: body.group._id };
  }

  /** A 900 dinner Aditi paid for, split three ways. */
  const dinner = (ctx) =>
    ctx.aditi.agent.post('/api/expenses').send({
      group: ctx.groupId,
      description: 'Dinner',
      amountCents: 90000,
      splitType: 'EQUAL',
      participants: [ctx.aditi.user.id, ctx.rahul.user.id, ctx.sara.user.id],
      paidBy: [{ userId: ctx.aditi.user.id, amountCents: 90000 }],
    });

  it('lets any member remove any other, not just whoever made the group', async () => {
    const ctx = await trio();

    // Sara did not create the group and is not an admin.
    const res = await ctx.sara.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.group.members).toHaveLength(2);

    expect((await ctx.rahul.agent.get(`/api/groups/${ctx.groupId}`)).status).toBe(403);
  });

  it('lets you leave a group yourself', async () => {
    const ctx = await trio();
    const res = await ctx.rahul.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(res.status).toBe(200);
    expect((await ctx.rahul.agent.get('/api/groups')).body.groups).toHaveLength(0);
  });

  it('leaves every recorded expense and payment exactly as it was', async () => {
    const ctx = await trio();
    await dinner(ctx);

    // Square Rahul off so he is allowed to go.
    await ctx.rahul.agent.post('/api/settlements').send({
      group: ctx.groupId,
      from: ctx.rahul.user.id,
      to: ctx.aditi.user.id,
      amountCents: 30000,
    });

    const before = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    const beforeBalances = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);

    const gone = await ctx.aditi.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(gone.status).toBe(200);

    const after = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    expect(after.body.expenses).toEqual(before.body.expenses);

    // He is still named on the dinner, with his third of it.
    const [expense] = after.body.expenses;
    const his = expense.shares.find((s) => s.user._id === ctx.rahul.user.id);
    expect(his.amountCents).toBe(30000);
    expect(expense.shares.find((s) => s.user._id === ctx.rahul.user.id).user.name).toBe('Rahul');

    // And his payment is still on the books.
    const payments = await ctx.aditi.agent.get(`/api/settlements?group=${ctx.groupId}`);
    expect(payments.body.settlements).toHaveLength(1);
    expect(payments.body.settlements[0].from.name).toBe('Rahul');

    // Balances are untouched: everyone still nets to what they did before.
    const afterBalances = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);
    expect(afterBalances.body.net).toEqual(beforeBalances.body.net);
  });

  it('refuses while they still owe or are owed, and says which way', async () => {
    const ctx = await trio();
    await dinner(ctx);

    const owes = await ctx.aditi.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(owes.status).toBe(400);
    expect(owes.body.error).toMatch(/Rahul still owes ₹300\.00/);

    const owed = await ctx.rahul.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.aditi.user.id}`);
    expect(owed.status).toBe(400);
    expect(owed.body.error).toMatch(/Aditi is still owed ₹600\.00/);

    // And phrased in the second person when you are the one leaving.
    const me = await ctx.rahul.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(me.status).toBe(400);
    expect(me.body.error).toMatch(/You still owe/);
  });

  it('refuses while a standing bill would keep charging them', async () => {
    const ctx = await trio();

    const template = await ctx.aditi.agent.post('/api/recurring').send({
      group: ctx.groupId,
      description: 'Internet',
      amountCents: 90000,
      splitType: 'EQUAL',
      participants: [ctx.aditi.user.id, ctx.rahul.user.id, ctx.sara.user.id],
      paidBy: [{ userId: ctx.aditi.user.id, amountCents: 90000 }],
      frequency: 'monthly',
      // Starts well ahead, so nothing has fallen due and balances stay clean —
      // this test is about the schedule, not about who owes what.
      startDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    });
    expect(template.status).toBe(201);

    const res = await ctx.aditi.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"Internet" would keep billing Rahul/);

    // Pausing it clears the way.
    await ctx.aditi.agent
      .patch(`/api/recurring/${template.body.recurring._id}`)
      .send({ active: false });
    expect(
      (await ctx.aditi.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`)).status,
    ).toBe(200);
  });

  it('keeps a stand-in on file when their expenses would be orphaned', async () => {
    const aditi = await signUp('Aditi');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Flat' });
    const groupId = body.group._id;
    const { body: added } = await aditi.agent
      .post(`/api/groups/${groupId}/placeholders`)
      .send({ name: 'Priya' });
    const priya = added.placeholder;

    await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Rent',
      amountCents: 60000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, priya.id],
      paidBy: [
        { userId: aditi.user.id, amountCents: 30000 },
        { userId: priya.id, amountCents: 30000 },
      ],
    });

    const res = await aditi.agent.delete(`/api/groups/${groupId}/members/${priya.id}`);
    expect(res.status).toBe(200);
    expect(res.body.group.members).toHaveLength(1);

    // The user record survives, so the rent still reads "Priya" and not a blank.
    const expenses = await aditi.agent.get(`/api/expenses?group=${groupId}`);
    const share = expenses.body.expenses[0].shares.find((s) => s.user._id === priya.id);
    expect(share.user.name).toBe('Priya');
  });

  it('cleans up a stand-in who was never used', async () => {
    const aditi = await signUp('Aditi');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Flat' });
    const groupId = body.group._id;
    const { body: added } = await aditi.agent
      .post(`/api/groups/${groupId}/placeholders`)
      .send({ name: 'Priya' });

    expect(
      (await aditi.agent.delete(`/api/groups/${groupId}/members/${added.placeholder.id}`)).status,
    ).toBe(200);

    // Free to add them again under the same name.
    expect(
      (await aditi.agent.post(`/api/groups/${groupId}/placeholders`).send({ name: 'Priya' })).status,
    ).toBe(201);
  });

  it('will not empty a group, or remove someone who was never in it', async () => {
    const aditi = await signUp('Aditi');
    const stranger = await signUp('Mallory');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Solo' });

    const last = await aditi.agent.delete(`/api/groups/${body.group._id}/members/${aditi.user.id}`);
    expect(last.status).toBe(400);
    expect(last.body.error).toMatch(/at least one member/);

    const nobody = await aditi.agent.delete(
      `/api/groups/${body.group._id}/members/${stranger.user.id}`,
    );
    expect(nobody.status).toBe(404);
  });

  it('keeps outsiders from editing the roster', async () => {
    const ctx = await trio();
    const mallory = await signUp('Mallory');
    expect(
      (await mallory.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.sara.user.id}`)).status,
    ).toBe(403);
  });

  it('still lets an old expense be corrected after someone leaves', async () => {
    const ctx = await trio();
    await dinner(ctx);
    const { body: list } = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    const expenseId = list.expenses[0]._id;

    await ctx.rahul.agent.post('/api/settlements').send({
      group: ctx.groupId,
      from: ctx.rahul.user.id,
      to: ctx.aditi.user.id,
      amountCents: 30000,
    });
    expect(
      (await ctx.aditi.agent.delete(`/api/groups/${ctx.groupId}/members/${ctx.rahul.user.id}`)).status,
    ).toBe(200);

    // Fixing the description of a dinner Rahul was genuinely at must still work.
    const fixed = await ctx.aditi.agent.patch(`/api/expenses/${expenseId}`).send({
      group: ctx.groupId,
      description: 'Dinner at Britannia',
      amountCents: 90000,
      splitType: 'EQUAL',
      participants: [ctx.aditi.user.id, ctx.rahul.user.id, ctx.sara.user.id],
      paidBy: [{ userId: ctx.aditi.user.id, amountCents: 90000 }],
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.expense.description).toBe('Dinner at Britannia');

    // But he cannot be put on anything new.
    const fresh = await ctx.aditi.agent.post('/api/expenses').send({
      group: ctx.groupId,
      description: 'Cab',
      amountCents: 60000,
      splitType: 'EQUAL',
      participants: [ctx.aditi.user.id, ctx.rahul.user.id],
      paidBy: [{ userId: ctx.aditi.user.id, amountCents: 60000 }],
    });
    expect(fresh.status).toBe(400);
    expect(fresh.body.error).toMatch(/must be a member of the group/);
  });
});

describe('expenses and balances', () => {
  /** Three friends in one group — the fixture for the split tests. */
  async function trio() {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');
    const sara = await signUp('Sara');
    const { body } = await aditi.agent.post('/api/groups').send({
      name: 'Flatmates',
      memberIds: [rahul.user.id, sara.user.id],
    });
    return { aditi, rahul, sara, groupId: body.group._id };
  }

  it('splits an expense equally and reports balances', async () => {
    const { aditi, rahul, sara, groupId } = await trio();

    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Groceries',
      amountCents: 90000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id, sara.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 90000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.expense.shares).toHaveLength(3);

    const balances = await rahul.agent.get(`/api/groups/${groupId}/balances`);
    const net = Object.fromEntries(balances.body.net.map((n) => [n.userId, n.amountCents]));
    expect(net[aditi.user.id]).toBe(60000);
    expect(net[rahul.user.id]).toBe(-30000);
    // and the hydrated payload carries names for rendering
    expect(balances.body.debts[0].toUser.name).toBe('Aditi');
  });

  it('splits a restaurant bill dish by dish, with tax and tip', async () => {
    const { aditi, rahul, sara, groupId } = await trio();

    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Dinner at Bombay Canteen',
      splitType: 'ITEMIZED',
      items: [
        {
          name: 'Paneer Tikka',
          priceCents: 32000,
          qty: 1,
          sharedBy: [aditi.user.id, rahul.user.id, sara.user.id],
        },
        {
          name: 'Butter Naan',
          priceCents: 6000,
          qty: 4,
          sharedBy: [aditi.user.id, rahul.user.id, sara.user.id],
        },
        { name: 'Tiramisu', priceCents: 24000, qty: 1, sharedBy: [rahul.user.id, sara.user.id] },
      ],
      taxCents: 5000,
      tipCents: 4000,
      paidBy: [{ userId: aditi.user.id, amountCents: 89000 }],
    });

    expect(res.status).toBe(201);
    // The total is derived from the dishes — the client need not send it.
    expect(res.body.expense.amountCents).toBe(89000);

    const shares = Object.fromEntries(
      res.body.expense.shares.map((s) => [s.user._id ?? s.user, s.amountCents]),
    );
    // Aditi skipped dessert, so she owes distinctly less than the other two.
    expect(shares[aditi.user.id]).toBeLessThan(shares[rahul.user.id]);
    expect(shares[aditi.user.id] + shares[rahul.user.id] + shares[sara.user.id]).toBe(89000);
    // and she carries a smaller slice of the tax and tip too
    expect(shares[aditi.user.id]).toBe(20767);
  });

  it('rejects a dish-wise bill with a dish nobody claimed', async () => {
    const { aditi, groupId } = await trio();
    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Lunch',
      splitType: 'ITEMIZED',
      items: [{ name: 'Fries', priceCents: 10000, qty: 1, sharedBy: [] }],
      paidBy: [{ userId: aditi.user.id, amountCents: 10000 }],
    });
    expect(res.status).toBe(400);
  });

  it('recomputes shares server-side and ignores anything the client sends', async () => {
    const { aditi, rahul, sara, groupId } = await trio();
    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Nice try',
      amountCents: 90000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id, sara.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 90000 }],
      // A tampered client claiming Aditi owes nothing:
      shares: [{ user: rahul.user.id, amountCents: 90000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.expense.shares).toHaveLength(3);
    for (const share of res.body.expense.shares) expect(share.amountCents).toBe(30000);
  });

  it('rejects percentages that do not add up and mismatched payers', async () => {
    const { aditi, rahul, groupId } = await trio();

    const badPercent = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Bad percent',
      amountCents: 10000,
      splitType: 'PERCENT',
      percentBps: { [aditi.user.id]: 5000, [rahul.user.id]: 4000 },
      paidBy: [{ userId: aditi.user.id, amountCents: 10000 }],
    });
    expect(badPercent.status).toBe(400);
    expect(badPercent.body.error).toMatch(/100%/);

    const badPayer = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Bad payer',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 9000 }],
    });
    expect(badPayer.status).toBe(400);
  });

  it('refuses to involve someone outside the group', async () => {
    const { aditi, groupId } = await trio();
    const outsider = await signUp('Mallory');

    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Sneaky',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, outsider.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 10000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member of the group/);
  });

  it('simplifies debts and settles the group down to zero', async () => {
    const { aditi, rahul, sara, groupId } = await trio();
    const people = [aditi, rahul, sara];

    // Everybody pays for something, split three ways: a proper tangle.
    for (const [i, payer] of people.entries()) {
      const amountCents = 30000 + i * 3000;
      const res = await payer.agent.post('/api/expenses').send({
        group: groupId,
        description: `Expense ${i}`,
        amountCents,
        splitType: 'EQUAL',
        participants: people.map((p) => p.user.id),
        paidBy: [{ userId: payer.user.id, amountCents }],
      });
      expect(res.status).toBe(201);
    }

    const before = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    expect(before.body.simplifyEnabled).toBe(true);
    // Fewer payments than the raw pairwise tangle, and never more than n-1.
    expect(before.body.simplified.length).toBeLessThan(before.body.pairwise.length);
    expect(before.body.simplified.length).toBeLessThanOrEqual(2);

    // Pay off every suggested transfer.
    for (const debt of before.body.simplified) {
      const res = await aditi.agent.post('/api/settlements').send({
        group: groupId,
        from: debt.from,
        to: debt.to,
        amountCents: debt.amountCents,
      });
      expect(res.status).toBe(201);
    }

    const after = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    expect(after.body.net).toEqual([]);
    expect(after.body.debts).toEqual([]);
  });

  it('honours the simplify toggle', async () => {
    const { aditi, rahul, sara, groupId } = await trio();
    for (const payer of [aditi, rahul]) {
      await payer.agent.post('/api/expenses').send({
        group: groupId,
        description: 'Shared',
        amountCents: 30000,
        splitType: 'EQUAL',
        participants: [aditi.user.id, rahul.user.id, sara.user.id],
        paidBy: [{ userId: payer.user.id, amountCents: 30000 }],
      });
    }

    const on = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    expect(on.body.debts).toEqual(on.body.simplified);

    await aditi.agent.patch(`/api/groups/${groupId}`).send({ simplifyDebts: false });
    const off = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    expect(off.body.simplifyEnabled).toBe(false);
    expect(off.body.debts).toEqual(off.body.pairwise);
  });

  it('removes a deleted expense from the balances', async () => {
    const { aditi, rahul, sara, groupId } = await trio();
    const created = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Oops',
      amountCents: 30000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id, sara.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 30000 }],
    });

    await aditi.agent.delete(`/api/expenses/${created.body.expense._id}`);
    const balances = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    expect(balances.body.net).toEqual([]);
  });

  it('blocks removing a member who still owes money', async () => {
    const { aditi, rahul, sara, groupId } = await trio();
    await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Rent',
      amountCents: 30000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id, sara.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 30000 }],
    });

    const blocked = await aditi.agent.delete(`/api/groups/${groupId}/members/${rahul.user.id}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/settle up first/);

    await aditi.agent.post('/api/settlements').send({
      group: groupId,
      from: rahul.user.id,
      to: aditi.user.id,
      amountCents: 10000,
    });
    const allowed = await aditi.agent.delete(`/api/groups/${groupId}/members/${rahul.user.id}`);
    expect(allowed.status).toBe(200);
  });
});

describe('scanning a bill', () => {
  // A one-pixel JPEG, long enough to clear the minimum-length guard. The
  // upstream call is stubbed in every test, so the bytes are never looked at.
  const IMAGE = 'x'.repeat(200);
  const body = { imageBase64: IMAGE, mimeType: 'image/jpeg' };

  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GEMINI_API_KEY;
  });

  /** Make the next Gemini call answer with this, without touching the network. */
  function stubGemini(response) {
    process.env.GEMINI_API_KEY = 'test-key';
    globalThis.fetch = async () => response;
  }
  const geminiReturns = (payload) =>
    stubGemini({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      }),
    });

  it('needs you to be signed in', async () => {
    const res = await request(app).post('/api/expenses/scan').send(body);
    expect(res.status).toBe(401);
  });

  it('asks the browser to do it locally when no key is configured', async () => {
    const { agent } = await signUp('Aditi');
    const res = await agent.post('/api/expenses/scan').send(body);

    // Deliberately 200: falling back is a normal outcome, not an error.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: null, fallback: 'tesseract', reason: 'no-key' });
  });

  it('returns dishes and extras in paise when Gemini answers', async () => {
    const { agent } = await signUp('Aditi');
    geminiReturns({
      items: [
        { name: 'Paneer Tikka', qty: 1, price: 320 },
        { name: 'Butter Naan', qty: 2, price: 90 },
      ],
      tax: 25.5,
      tip: 40,
      total: 565.5,
      currency: 'INR',
    });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(res.body.scan.items).toEqual([
      { name: 'Paneer Tikka', qty: 1, priceCents: 32000 },
      { name: 'Butter Naan', qty: 2, priceCents: 9000 },
    ]);
    expect(res.body.scan.taxCents).toBe(2550);
    expect(res.body.scan.tipCents).toBe(4000);
    // 32000 + 2×9000 + 2550 + 4000 = 56550, matching the printed total.
    expect(res.body.reconcile).toMatchObject({ derivedCents: 56550, diffCents: 0 });
  });

  it('flags a bill whose total disagrees with the lines found', async () => {
    const { agent } = await signUp('Aditi');
    geminiReturns({ items: [{ name: 'Thali', price: 250 }], total: 500 });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.body.reconcile.diffCents).toBe(25000);
  });

  it('falls back rather than erroring when the free allowance is spent', async () => {
    const { agent } = await signUp('Aditi');
    stubGemini({ ok: false, status: 429, text: async () => 'rate limited' });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.status).toBe(200);
    // 'quota', not the generic 'upstream': the free tier resetting tomorrow is
    // a different thing to tell someone than a capacity blip clearing in
    // minutes, and the panel says which.
    expect(res.body).toMatchObject({ provider: null, fallback: 'tesseract', reason: 'quota' });
  });

  it('reports a busy upstream as temporary, not as spent quota', async () => {
    const { agent } = await signUp('Aditi');
    stubGemini({ ok: false, status: 503, text: async () => 'high demand' });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.body).toMatchObject({ fallback: 'tesseract', reason: 'upstream' });
  });

  it('falls back when the model returns something that is not JSON', async () => {
    const { agent } = await signUp('Aditi');
    stubGemini({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sorry, I cannot.' }] } }] }),
    });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.body.fallback).toBe('tesseract');
  });

  it('says so plainly when the photo has no dishes on it', async () => {
    const { agent } = await signUp('Aditi');
    geminiReturns({ items: [], total: 500 });

    const res = await agent.post('/api/expenses/scan').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/find any dishes/i);
  });

  it('rejects anything that is not a photo, and anything too big', async () => {
    const { agent } = await signUp('Aditi');

    const wrongType = await agent
      .post('/api/expenses/scan')
      .send({ imageBase64: IMAGE, mimeType: 'application/pdf' });
    expect(wrongType.status).toBe(400);

    const tooBig = await agent
      .post('/api/expenses/scan')
      .send({ imageBase64: 'x'.repeat(2_200_001), mimeType: 'image/jpeg' });
    expect(tooBig.status).toBe(400);
  });

  it('accepts a photo far larger than the 256kb limit the rest of the API has', async () => {
    const { agent } = await signUp('Aditi');
    geminiReturns({ items: [{ name: 'Thali', price: 250 }] });

    // ~1.5MB of base64: rejected outright if the scan path shares the global
    // body limit, which is exactly the regression this guards.
    const res = await agent
      .post('/api/expenses/scan')
      .send({ imageBase64: 'x'.repeat(1_500_000), mimeType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
  });

  it('never sends the API key in the URL', async () => {
    const { agent } = await signUp('Aditi');
    process.env.GEMINI_API_KEY = 'super-secret';
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init };
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"items":[{"name":"X","price":1}]}' }] } }],
        }),
      };
    };

    await agent.post('/api/expenses/scan').send(body);
    expect(seen.url).not.toContain('super-secret');
    expect(seen.init.headers['x-goog-api-key']).toBe('super-secret');
  });
});

describe('placeholder people', () => {
  async function groupWithPlaceholder() {
    const aditi = await signUp('Aditi');
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Flat' });
    const groupId = body.group._id;
    const res = await aditi.agent.post(`/api/groups/${groupId}/placeholders`).send({ name: 'Priya' });
    expect(res.status).toBe(201);
    return { aditi, groupId, priya: res.body.placeholder };
  }

  it('adds someone without an account as a group member', async () => {
    const { priya, groupId, aditi } = await groupWithPlaceholder();
    expect(priya.name).toBe('Priya');
    expect(priya.isPlaceholder).toBe(true);
    // Internal filler must never be shown as if it were real contact detail.
    expect(priya.email).toBeUndefined();
    expect(priya.username).toBeUndefined();

    const group = await aditi.agent.get(`/api/groups/${groupId}`);
    expect(group.body.group.members).toHaveLength(2);
  });

  it('splits expenses with a placeholder exactly like a real member', async () => {
    const { aditi, groupId, priya } = await groupWithPlaceholder();
    const res = await aditi.agent.post('/api/expenses').send({
      group: groupId,
      description: 'Rent',
      amountCents: 30_000_00,
      splitType: 'EQUAL',
      participants: [aditi.user.id, priya.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 30_000_00 }],
    });
    expect(res.status).toBe(201);

    const balances = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    const net = Object.fromEntries(balances.body.net.map((n) => [n.userId, n.amountCents]));
    expect(net[aditi.user.id]).toBe(15_000_00);
    expect(net[priya.id]).toBe(-15_000_00);
    expect(balances.body.debts[0].fromUser.name).toBe('Priya');
  });

  it('records a payment from a placeholder', async () => {
    const { aditi, groupId, priya } = await groupWithPlaceholder();
    const res = await aditi.agent.post('/api/settlements').send({
      group: groupId, from: priya.id, to: aditi.user.id, amountCents: 500_00,
    });
    expect(res.status).toBe(201);
  });

  it('cannot be signed in as, searched for, or befriended', async () => {
    const { priya } = await groupWithPlaceholder();
    const other = await signUp('Rahul');

    // The internal email is unguessable, but try it anyway.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: `guest_${priya.id.slice(-10)}@placeholder.invalid`, password: 'password123' });
    expect(login.status).toBe(401);

    const search = await other.agent.get('/api/users/search?q=Priya');
    expect(search.body.users).toEqual([]);

    const friend = await other.agent.post('/api/users/friends').send({ handle: 'Priya' });
    expect(friend.status).toBe(404);
  });

  it('keeps stand-ins out of other groups', async () => {
    const { aditi, priya } = await groupWithPlaceholder();
    const { body } = await aditi.agent.post('/api/groups').send({ name: 'Other' });

    const res = await aditi.agent.post('/api/groups/' + body.group._id + '/members').send({
      handle: `guest_${priya.id.slice(-10)}`,
    });
    expect(res.status).toBe(404);
  });

  it('hands the whole history over when the real person signs up', async () => {
    const { aditi, groupId, priya } = await groupWithPlaceholder();

    await aditi.agent.post('/api/expenses').send({
      group: groupId, description: 'Rent', amountCents: 30_000_00, splitType: 'EQUAL',
      participants: [aditi.user.id, priya.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 30_000_00 }],
    });
    await aditi.agent.post('/api/expenses').send({
      group: groupId, description: 'Dinner', splitType: 'ITEMIZED',
      items: [{ name: 'Pizza', priceCents: 40_000, qty: 1, sharedBy: [aditi.user.id, priya.id] }],
      paidBy: [{ userId: priya.id, amountCents: 40_000 }],
    });

    const before = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    const priyaBefore = before.body.net.find((n) => n.userId === priya.id).amountCents;

    // Priya finally signs up, and someone links her in.
    const real = await signUp('Priya');
    const link = await aditi.agent
      .post(`/api/groups/${groupId}/placeholders/${priya.id}/link`)
      .send({ handle: 'priya' });
    expect(link.status).toBe(200);
    expect(link.body.linkedTo.username).toBe('priya');

    const after = await aditi.agent.get(`/api/groups/${groupId}/balances`);
    const priyaAfter = after.body.net.find((n) => n.userId === real.user.id)?.amountCents;

    // The balance moves across untouched — nothing invented, nothing lost.
    expect(priyaAfter).toBe(priyaBefore);
    expect(after.body.net.some((n) => n.userId === priya.id)).toBe(false);

    // And she can now see the group herself, dish participation included.
    const hers = await real.agent.get(`/api/expenses?group=${groupId}`);
    expect(hers.status).toBe(200);
    const dinner = hers.body.expenses.find((e) => e.description === 'Dinner');
    expect(dinner.items[0].sharedBy.map((u) => u._id)).toContain(real.user.id);
    expect(String(dinner.paidBy[0].user._id)).toBe(real.user.id);
  });

  it('refuses to link onto someone already in the group', async () => {
    const { aditi, groupId, priya } = await groupWithPlaceholder();
    const res = await aditi.agent
      .post(`/api/groups/${groupId}/placeholders/${priya.id}/link`)
      .send({ handle: 'aditi' });
    expect(res.status).toBe(409);
  });

  it('only lets group members create stand-ins', async () => {
    const { groupId } = await groupWithPlaceholder();
    const outsider = await signUp('Mallory');
    const res = await outsider.agent.post(`/api/groups/${groupId}/placeholders`).send({ name: 'Ghost' });
    expect(res.status).toBe(403);
  });
});

describe('payments', () => {
  async function withPayment() {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');
    const sara = await signUp('Sara');
    const { body } = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Flat', memberIds: [rahul.user.id, sara.user.id] });
    const groupId = body.group._id;

    // A payment between two people that do NOT include the creator.
    const res = await aditi.agent.post('/api/settlements').send({
      group: groupId,
      from: rahul.user.id,
      to: sara.user.id,
      amountCents: 50_00,
    });
    expect(res.status).toBe(201);
    return { aditi, rahul, sara, groupId, payment: res.body.settlement };
  }

  it('lets any group member edit a payment, not just the two involved', async () => {
    const ctx = await withPayment();
    // Aditi is neither payer nor payee here, but shares the ledger.
    const edited = await ctx.aditi.agent
      .patch(`/api/settlements/${ctx.payment._id}`)
      .send({ amountCents: 75_00, note: 'corrected' });
    expect(edited.status).toBe(200);
    expect(edited.body.settlement.amountCents).toBe(75_00);

    // and so can the other uninvolved member
    const bySara = await ctx.sara.agent
      .patch(`/api/settlements/${ctx.payment._id}`)
      .send({ amountCents: 60_00 });
    expect(bySara.status).toBe(200);
  });

  it('lets any group member delete a payment, and balances follow', async () => {
    const ctx = await withPayment();
    const before = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);
    expect(before.body.net.length).toBeGreaterThan(0);

    const del = await ctx.sara.agent.delete(`/api/settlements/${ctx.payment._id}`);
    expect(del.status).toBe(200);

    const after = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);
    expect(after.body.net).toEqual([]);
    const list = await ctx.aditi.agent.get(`/api/settlements?group=${ctx.groupId}`);
    expect(list.body.settlements).toEqual([]);
  });

  it('keeps outsiders out of a group ledger', async () => {
    const ctx = await withPayment();
    const mallory = await signUp('Mallory');
    expect(
      (await mallory.agent.patch(`/api/settlements/${ctx.payment._id}`).send({ amountCents: 1 }))
        .status,
    ).toBe(403);
    expect((await mallory.agent.delete(`/api/settlements/${ctx.payment._id}`)).status).toBe(403);
  });

  it('can redirect a payment recorded against the wrong person', async () => {
    const ctx = await withPayment();
    const fixed = await ctx.aditi.agent
      .patch(`/api/settlements/${ctx.payment._id}`)
      .send({ to: ctx.aditi.user.id });
    expect(fixed.status).toBe(200);
    expect(String(fixed.body.settlement.to._id)).toBe(ctx.aditi.user.id);

    const sameParty = await ctx.aditi.agent
      .patch(`/api/settlements/${ctx.payment._id}`)
      .send({ to: ctx.rahul.user.id });
    expect(sameParty.status).toBe(400);
  });

  it('will not point a payment at someone outside the group', async () => {
    const ctx = await withPayment();
    const outsider = await signUp('Mallory');
    const res = await ctx.aditi.agent
      .patch(`/api/settlements/${ctx.payment._id}`)
      .send({ to: outsider.user.id });
    expect(res.status).toBe(400);
  });
});

describe('recurring expenses', () => {
  async function flat() {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');
    const sara = await signUp('Sara');
    const { body } = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Flat 402', type: 'home', memberIds: [rahul.user.id, sara.user.id] });
    return { aditi, rahul, sara, groupId: body.group._id };
  }

  const monthsAgo = (n) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString();
  };

  const rent = (ctx, extra = {}) => ({
    group: ctx.groupId,
    description: 'Rent',
    amountCents: 30_000_00,
    category: 'rent',
    splitType: 'EQUAL',
    participants: [ctx.aditi.user.id, ctx.rahul.user.id, ctx.sara.user.id],
    paidBy: [{ userId: ctx.aditi.user.id, amountCents: 30_000_00 }],
    frequency: 'monthly',
    startDate: monthsAgo(0),
    ...extra,
  });

  it('creates the first expense as soon as the series starts', async () => {
    const ctx = await flat();
    const res = await ctx.aditi.agent.post('/api/recurring').send(rent(ctx));
    expect(res.status).toBe(201);
    expect(res.body.generated).toBe(1);

    const expenses = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    expect(expenses.body.expenses).toHaveLength(1);
    expect(expenses.body.expenses[0].description).toBe('Rent');
  });

  it('backfills every missed cycle rather than just the latest', async () => {
    const ctx = await flat();
    // Started three months ago and nobody has opened the app since.
    const res = await ctx.aditi.agent
      .post('/api/recurring')
      .send(rent(ctx, { startDate: monthsAgo(3) }));
    expect(res.status).toBe(201);
    expect(res.body.generated).toBe(4); // this month plus the three missed

    const balances = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);
    const net = Object.fromEntries(balances.body.net.map((n) => [n.userId, n.amountCents]));
    // Four months of rent: Aditi is owed 4 x 20,000
    expect(net[ctx.aditi.user.id]).toBe(4 * 20_000_00);
    expect(net[ctx.rahul.user.id]).toBe(-4 * 10_000_00);
  });

  it('never double-charges, however many times it is triggered', async () => {
    const ctx = await flat();
    await ctx.aditi.agent.post('/api/recurring').send(rent(ctx, { startDate: monthsAgo(2) }));

    // Everyone opens the app at once; each read triggers a catch-up.
    await Promise.all([
      ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`),
      ctx.rahul.agent.get(`/api/groups/${ctx.groupId}/balances`),
      ctx.sara.agent.get(`/api/expenses?group=${ctx.groupId}`),
      ctx.aditi.agent.get('/api/dashboard/summary'),
      ctx.rahul.agent.get(`/api/expenses?group=${ctx.groupId}`),
    ]);

    const expenses = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    expect(expenses.body.expenses).toHaveLength(3); // 3 cycles, not 15
    const keys = expenses.body.expenses.map((e) => e.cycleKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('generated expenses behave like any other in simplify-debts', async () => {
    const ctx = await flat();
    await ctx.aditi.agent.post('/api/recurring').send(rent(ctx));
    await ctx.aditi.agent.post('/api/recurring').send({
      ...rent(ctx),
      description: 'Internet',
      amountCents: 1_200_00,
      paidBy: [{ userId: ctx.rahul.user.id, amountCents: 1_200_00 }],
    });

    const balances = await ctx.aditi.agent.get(`/api/groups/${ctx.groupId}/balances`);
    expect(balances.body.simplified.length).toBeLessThanOrEqual(2);
    expect(balances.body.net.reduce((s, n) => s + n.amountCents, 0)).toBe(0);
  });

  it('summarises standing commitments per month, netted down', async () => {
    const ctx = await flat();
    await ctx.aditi.agent.post('/api/recurring').send(rent(ctx));
    await ctx.aditi.agent.post('/api/recurring').send({
      ...rent(ctx),
      description: 'Cleaner',
      amountCents: 600_00,
      frequency: 'weekly',
      paidBy: [{ userId: ctx.sara.user.id, amountCents: 600_00 }],
    });

    const res = await ctx.aditi.agent.get(`/api/recurring/summary?group=${ctx.groupId}`);
    expect(res.status).toBe(200);
    // 30,000/month + (600 x 52/12 = 2,600)/month
    expect(res.body.totalMonthlyCents).toBe(30_000_00 + 2_600_00);
    expect(res.body.standingPayments.length).toBeLessThanOrEqual(2);
    expect(res.body.standingPayments[0].fromUser.username).toBeTruthy();
    expect(res.body.perMonthNet.reduce((s, n) => s + n.amountCents, 0)).toBe(0);
  });

  it('stops generating when paused, and keeps history when deleted', async () => {
    const ctx = await flat();
    const created = await ctx.aditi.agent
      .post('/api/recurring')
      .send(rent(ctx, { startDate: monthsAgo(1) }));
    const templateId = created.body.recurring._id;
    expect(created.body.generated).toBe(2);

    await ctx.aditi.agent.patch(`/api/recurring/${templateId}`).send({ active: false });
    const summary = await ctx.aditi.agent.get(`/api/recurring/summary?group=${ctx.groupId}`);
    expect(summary.body.items).toEqual([]);

    const del = await ctx.aditi.agent.delete(`/api/recurring/${templateId}`);
    expect(del.status).toBe(200);
    // The rent that already fell due was genuinely owed, so it stays.
    expect(del.body.keptExpenses).toBe(2);
    const after = await ctx.aditi.agent.get(`/api/expenses?group=${ctx.groupId}`);
    expect(after.body.expenses).toHaveLength(2);
  });

  it('keeps recurring expenses inside the group', async () => {
    const ctx = await flat();
    const outsider = await signUp('Mallory');

    const stranger = await ctx.aditi.agent.post('/api/recurring').send({
      ...rent(ctx),
      participants: [ctx.aditi.user.id, outsider.user.id],
    });
    expect(stranger.status).toBe(400);

    await ctx.aditi.agent.post('/api/recurring').send(rent(ctx));
    expect((await outsider.agent.get(`/api/recurring?group=${ctx.groupId}`)).status).toBe(403);
  });
});

describe('dashboard', () => {
  it('summarises what I owe and what I am owed', async () => {
    const aditi = await signUp('Aditi');
    const rahul = await signUp('Rahul');
    const { body } = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Flat', memberIds: [rahul.user.id] });

    await aditi.agent.post('/api/expenses').send({
      group: body.group._id,
      description: 'Internet',
      amountCents: 20000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, rahul.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 20000 }],
    });

    const mine = await aditi.agent.get('/api/dashboard/summary');
    expect(mine.body.owedToMeCents).toBe(10000);
    expect(mine.body.iOweCents).toBe(0);
    expect(mine.body.friends[0].user.name).toBe('Rahul');

    const theirs = await rahul.agent.get('/api/dashboard/summary');
    expect(theirs.body.iOweCents).toBe(10000);
    expect(theirs.body.netTotalCents).toBe(-10000);
  });

  /**
   * A settled group must leave nothing behind on the dashboard.
   *
   * Aditi covers Bhavna, Bhavna covers Chirag, so the simplified answer is the
   * single payment Chirag → Aditi. Once that's paid the group is square — but a
   * pairwise reading still sees Bhavna→Aditi and Chirag→Bhavna, plus the
   * reverse edge for the payment itself, and reports Aditi as both owed 5000
   * and owing 5000 around the loop.
   */
  it('drops a group from the friend list once its simplified debt is paid', async () => {
    const aditi = await signUp('Aditi');
    const bhavna = await signUp('Bhavna');
    const chirag = await signUp('Chirag');
    const { body } = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Chain', memberIds: [bhavna.user.id, chirag.user.id] });
    const group = body.group._id;
    expect(body.group.simplifyDebts).toBe(true);

    await aditi.agent.post('/api/expenses').send({
      group,
      description: 'Cab',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, bhavna.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 10000 }],
    });
    await bhavna.agent.post('/api/expenses').send({
      group,
      description: 'Lunch',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [bhavna.user.id, chirag.user.id],
      paidBy: [{ userId: bhavna.user.id, amountCents: 10000 }],
    });

    // The group offers exactly one payment, and it skips Bhavna entirely.
    const balances = await aditi.agent.get(`/api/groups/${group}/balances`);
    expect(balances.body.debts).toHaveLength(1);
    expect(balances.body.debts[0]).toMatchObject({
      from: chirag.user.id,
      to: aditi.user.id,
      amountCents: 5000,
    });

    const before = await aditi.agent.get('/api/dashboard/summary');
    expect(before.body.friends).toHaveLength(1);
    expect(before.body.friends[0].user.name).toBe('Chirag');
    expect(before.body.friends[0].amountCents).toBe(5000);

    await chirag.agent.post('/api/settlements').send({
      group,
      from: chirag.user.id,
      to: aditi.user.id,
      amountCents: 5000,
    });

    for (const person of [aditi, bhavna, chirag]) {
      const after = await person.agent.get('/api/dashboard/summary');
      expect(after.body.friends).toEqual([]);
      expect(after.body.owedToMeCents).toBe(0);
      expect(after.body.iOweCents).toBe(0);
      expect(after.body.netTotalCents).toBe(0);
      expect(after.body.groups[0].myBalanceCents).toBe(0);
    }
  });

  it('still reads a group pairwise when simplify is switched off', async () => {
    const aditi = await signUp('Aditi');
    const bhavna = await signUp('Bhavna');
    const chirag = await signUp('Chirag');
    const { body } = await aditi.agent
      .post('/api/groups')
      .send({ name: 'Chain', memberIds: [bhavna.user.id, chirag.user.id] });
    const group = body.group._id;
    await aditi.agent.patch(`/api/groups/${group}`).send({ simplifyDebts: false });

    await aditi.agent.post('/api/expenses').send({
      group,
      description: 'Cab',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [aditi.user.id, bhavna.user.id],
      paidBy: [{ userId: aditi.user.id, amountCents: 10000 }],
    });
    await bhavna.agent.post('/api/expenses').send({
      group,
      description: 'Lunch',
      amountCents: 10000,
      splitType: 'EQUAL',
      participants: [bhavna.user.id, chirag.user.id],
      paidBy: [{ userId: bhavna.user.id, amountCents: 10000 }],
    });

    // Bhavna nets to zero but genuinely owes and is owed 5000, and with
    // simplify off that is exactly what the dashboard should say.
    const hers = await bhavna.agent.get('/api/dashboard/summary');
    expect(hers.body.netTotalCents).toBe(0);
    expect(hers.body.owedToMeCents).toBe(5000);
    expect(hers.body.iOweCents).toBe(5000);
    expect(hers.body.friends.map((f) => [f.user.name, f.amountCents])).toEqual([
      ['Chirag', 5000],
      ['Aditi', -5000],
    ]);
  });
});
