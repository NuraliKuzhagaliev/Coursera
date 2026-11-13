import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import Stripe from "stripe";
import { createApp } from "../server/app.js";
import { tokenVerifier } from "../server/auth.js";
import { ApiError } from "../server/store.js";

const migration = (await Promise.all((await readdir("supabase/migrations")).filter(name => name.endsWith(".sql")).sort()
  .map(name => readFile("supabase/migrations/" + name, "utf8")))).join("\n");
const assessment = { title: "Fixture quiz", instructions: "Choose one.", peer: false,
  questions: [{ id: "q1", type: "single", prompt: "Fixture question", options: [{ id: "o1", text: "One" }, { id: "o2", text: "Two" }] }] };
const token = () => randomBytes(32).toString("hex");
async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz,not_after timestamptz);`);
  await db.exec(migration);
  const secret = token();
  await db.query("update coursera_queue.config set backend_key_hash=$1", [createHash("sha256").update(secret).digest("hex")]);
  const rpc = async (operation: string, payload: any = {}) => {
    const { rows } = await db.query<{ value: any }>("select public.cq_dispatch($1,$2,$3::jsonb) as value", [secret, operation, JSON.stringify(payload)]);
    const value = rows[0].value;
    if (value.error) throw new ApiError(value.error, ["rate_limited", "quota_exceeded"].includes(value.error) ? 429 : 403);
    return value;
  };
  const keys = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture-key", alg: "ES256", use: "sig" };
  const authServer = createServer((_request, response) => response.setHeader("Content-Type", "application/json").end(JSON.stringify({ keys: [jwk] })));
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  const origin = "http://127.0.0.1:" + (authServer.address() as any).port;
  const stripe = new Stripe("sk_test_fixture");
  let subscription: any;
  stripe.subscriptions.retrieve = (async () => subscription) as any;
  const app = await createApp({ supabaseUrl: origin, publishableKey: "fixture-public-key", serverKey: secret,
    adminOrigin: "http://127.0.0.1:3000", stripeWebhookSecret: "whsec_fixture" },
  { rpc, verify: tokenVerifier(origin, "fixture-public-key"), stripe });
  const newUser = async () => {
    const userId = randomUUID(), authSession = randomUUID();
    await db.query("insert into auth.users values($1,$2,now(),null)", [userId, userId + "@example.test"]);
    await db.query("insert into auth.sessions values($1,$2,clock_timestamp(),null)", [authSession, userId]);
    return signin(userId, authSession);
  };
  const signin = async (userId: string, authSession: string) => {
    const jwt = await new SignJWT({ session_id: authSession, role: "authenticated" }).setSubject(userId)
      .setIssuer(origin + "/auth/v1").setAudience("authenticated").setIssuedAt().setExpirationTime("1h")
      .setProtectedHeader({ alg: "ES256", kid: "fixture-key" }).sign(keys.privateKey);
    const identity = { userId, authSession, sessionToken: token(), deviceId: token(), sessionId: randomUUID() };
    const headers = { Authorization: "Bearer " + jwt, "X-CQ-Session": identity.sessionToken,
      "X-CQ-Device": identity.deviceId, "X-CQ-Version": "2.0.0" };
    return { identity, headers, jwt };
  };
  const post = (path: string, user: Awaited<ReturnType<typeof newUser>>, payload: any = {}) =>
    app.inject({ method: "POST", url: path, headers: user.headers, payload });
  const open = async (user: Awaited<ReturnType<typeof newUser>>) =>
    post("/v1/session/open", user, { sessionId: user.identity.sessionId, email: "forged@example.test", role: "admin" });
  const grant = async (userId: string) => db.query(
    "insert into coursera_queue.licenses(user_id,source,plan_id,status,expires_at) values($1,'manual','standard','active',now()+interval '1 day')", [userId]);
  return { db, app, rpc, newUser, signin, post, open, grant, stripe,
    setSubscription(value: any) { subscription = value; },
    async close() { await app.close(); authServer.closeAllConnections(); await new Promise<void>(resolve => authServer.close(() => resolve())); await db.close(); }
  };
}

test("JWT, session and email forgery cannot grant license or admin access", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/v1/engine/course", payload: { course: {} } })).statusCode, 401);
    const user = await f.newUser();
    const opened = await f.open(user);
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(opened.json().email, user.identity.userId + "@example.test");
    assert.equal(opened.json().role, "user");
    assert.equal((await f.app.inject({ method: "GET", url: "/v1/admin", headers: user.headers })).statusCode, 403);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit", active: true })).statusCode, 403);
    const changed = { ...user, headers: { ...user.headers, Authorization: "Bearer " + user.jwt.slice(0, -12) + "tampered12345" } };
    assert.equal((await f.post("/v1/license/authorize", changed, { operation: "submit" })).statusCode, 401);
    await f.grant(user.identity.userId);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).statusCode, 200);
    await f.db.query("update coursera_queue.licenses set expires_at=now()-interval '1 second'");
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).json().error, "license_required");
  } finally { await f.close(); }
});

test("new login atomically revokes the old session and old JWT cannot reopen it", async () => {
  const f = await fixture();
  try {
    const first = await f.newUser();
    assert.equal((await f.open(first)).statusCode, 200);
    await f.grant(first.identity.userId);
    const id = randomUUID();
    await f.db.query("insert into auth.sessions values($1,$2,clock_timestamp()+interval '1 second',null)", [id, first.identity.userId]);
    const second = await f.signin(first.identity.userId, id);
    assert.equal((await f.open(second)).statusCode, 200);
    assert.equal((await f.post("/v1/license/authorize", first, { operation: "submit" })).json().error, "session_revoked");
    assert.equal((await f.open(first)).json().error, "session_revoked");
    assert.equal((await f.post("/v1/license/authorize", second, { operation: "submit" })).statusCode, 200);
    assert.equal((await f.db.query<{ count: number }>("select count(*)::int as count from coursera_queue.sessions where revoked_at is null")).rows[0].count, 1);
    await f.db.query("update coursera_queue.accounts set device_lock=true");
    const thirdId = randomUUID();
    await f.db.query("insert into auth.sessions values($1,$2,clock_timestamp()+interval '2 seconds',null)", [thirdId, first.identity.userId]);
    const third = await f.signin(first.identity.userId, thirdId);
    assert.equal((await f.open(third)).json().error, "device_locked");
    await f.db.query("update coursera_queue.accounts set registered_device=$1", [token()]);
    assert.equal((await f.post("/v1/license/authorize", second, { operation: "submit" })).json().error, "device_locked");
  } finally { await f.close(); }
});

test("concurrent logins leave one active session and logout and revocation take effect immediately", async () => {
  const f = await fixture();
  try {
    const first = await f.newUser();
    await f.open(first); await f.grant(first.identity.userId);
    const secondAuth = randomUUID(), thirdAuth = randomUUID();
    await f.db.query("insert into auth.sessions values($1,$2,clock_timestamp()+interval '1 second',null),($3,$2,clock_timestamp()+interval '2 seconds',null)",
      [secondAuth, first.identity.userId, thirdAuth]);
    const second = await f.signin(first.identity.userId, secondAuth), third = await f.signin(first.identity.userId, thirdAuth);
    await Promise.all([f.open(second), f.open(third)]);
    const active = (await f.db.query<{ id: string }>("select id from coursera_queue.sessions where revoked_at is null")).rows;
    assert.equal(active.length, 1);
    assert.equal(active[0].id, third.identity.sessionId);
    await f.db.query("update coursera_queue.accounts set role='admin' where user_id=$1", [third.identity.userId]);
    assert.equal((await f.post("/v1/admin/revoke", third, { targetUser: third.identity.userId })).statusCode, 200);
    assert.equal((await f.post("/v1/license/authorize", third, { operation: "submit" })).json().error, "license_required");
    assert.equal((await f.post("/v1/session/close", third)).statusCode, 200);
    assert.equal((await f.post("/v1/license/status", third)).json().error, "session_revoked");
  } finally { await f.close(); }
});

test("missing Auth session, rate cap and minimum extension version fail closed", async () => {
  const f = await fixture();
  try {
    const user = await f.newUser(); await f.open(user); await f.grant(user.identity.userId);
    await f.db.query("update coursera_queue.plans set requests_per_minute=1");
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).statusCode, 200);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).json().error, "rate_limited");
    await f.db.query("update coursera_queue.plans set requests_per_minute=120");
    const outdated = { ...user, headers: { ...user.headers, "X-CQ-Version": "1.1.22" } };
    assert.equal((await f.post("/v1/license/authorize", outdated, { operation: "submit" })).json().error, "update_required");
    await f.db.query("delete from auth.sessions where id=$1", [user.identity.authSession]);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).json().error, "auth_required");
  } finally { await f.close(); }
});

test("private tables reject browser roles and server RPC rejects a forged credential", async () => {
  const f = await fixture();
  try {
    await f.db.exec("set role anon");
    await assert.rejects(() => f.db.query("select * from coursera_queue.licenses"), /permission denied/);
    const result = await f.db.query<{ value: any }>("select public.cq_dispatch('fake','config','{}') as value");
    assert.equal(result.rows[0].value.error, "server_auth_required");
    await f.db.exec("reset role");
    const rows = await f.db.query<{ enabled: boolean }>("select relrowsecurity as enabled from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='coursera_queue' and c.relkind='r'");
    assert(rows.rows.length >= 10);
    assert(rows.rows.every(row => row.enabled));
  } finally { await f.close(); }
});

test("quota counts retries once and answer jobs bind user, session and assessment", async () => {
  const f = await fixture();
  try {
    const user = await f.newUser();
    await f.open(user); await f.grant(user.identity.userId);
    await f.db.query("update coursera_queue.plans set daily_quota=1 where id='standard'");
    const requestId = "assignment-" + randomUUID();
    const body = { assessment, requestId };
    const prompt = await f.post("/v1/engine/prompt", user, body);
    assert.equal(prompt.statusCode, 200, prompt.body);
    assert.equal((await f.post("/v1/engine/prompt", user, body)).statusCode, 200);
    assert.equal((await f.post("/v1/engine/prompt", user, { ...body, assessment: { ...assessment, title: "Different quiz" } })).json().error, "request_conflict");
    assert.equal((await f.post("/v1/engine/prompt", user, { ...body, correction: "Different correction" })).json().error, "request_conflict");
    assert.equal((await f.post("/v1/engine/prompt", user, { ...body, requestId: "assignment-" + randomUUID() })).json().error, "quota_exceeded");
    const answer = { requestId, answers: [{ id: "q1", choices: ["o2"] }], manual: "" };
    const valid = await f.post("/v1/engine/answer", user, { ...body, job: prompt.json().job, reply: JSON.stringify(answer) });
    assert.equal(valid.statusCode, 200, valid.body);
    const altered = await f.post("/v1/engine/answer", user, { ...body, assessment: { ...assessment, title: "Altered" },
      job: prompt.json().job, reply: JSON.stringify(answer) });
    assert.equal(altered.json().error, "job_invalid");
    const other = await f.newUser();
    await f.open(other); await f.grant(other.identity.userId);
    assert.equal((await f.post("/v1/engine/answer", other, { ...body, job: prompt.json().job, reply: JSON.stringify(answer) })).json().error, "job_invalid");
    await f.db.query("update coursera_queue.accounts set blocked=true where user_id=$1", [user.identity.userId]);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).json().error, "account_blocked");
  } finally { await f.close(); }
});

test("signed billing is idempotent and older events reconcile the current Stripe state", async () => {
  const f = await fixture();
  try {
    const user = await f.newUser(); await f.open(user);
    await f.db.query("update coursera_queue.accounts set stripe_customer='cus_fixture'");
    await f.db.query("update coursera_queue.plans set stripe_price_id='price_fixture',amount=1000 where id='standard'");
    const subscription = { id: "sub_fixture", customer: "cus_fixture", status: "active",
      items: { data: [{ current_period_end: Math.floor(Date.now()/1000)+3600,
        price: { id: "price_fixture", unit_amount: 1000, currency: "usd" } }] },
      latest_invoice: { status: "paid" } };
    f.setSubscription(subscription);
    const event = (id: string) => ({ id, type: "customer.subscription.updated", livemode: false,
      data: { object: { id: "sub_fixture", object: "subscription" } } });
    const deliver = async (id: string, valid = true) => {
      const payload = JSON.stringify(event(id));
      return f.app.inject({ method: "POST", url: "/v1/billing/webhook", payload,
        headers: { "content-type": "application/json", "stripe-signature": valid ?
          f.stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_fixture" }) : "fake" } });
    };
    assert.equal((await deliver("evt_bad", false)).statusCode, 400);
    assert.equal((await deliver("evt_good")).statusCode, 200);
    assert.equal((await deliver("evt_good")).statusCode, 200);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).statusCode, 200);
    await f.rpc("billing.claim", { subscriptionId: "sub_other", eventId: "evt_other", owner: user.identity.sessionId });
    await f.rpc("billing.commit", { subscriptionId: "sub_other", eventId: "evt_other", owner: user.identity.sessionId,
      customerId: "cus_fixture", priceId: "price_fixture", amount: 1000, currency: "usd", status: "canceled", paid: false,
      periodEnd: Math.floor(Date.now()/1000)+3600 });
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).statusCode, 200);
    f.setSubscription({ ...subscription, status: "canceled" });
    assert.equal((await deliver("evt_older")).statusCode, 200);
    assert.equal((await f.post("/v1/license/authorize", user, { operation: "submit" })).json().error, "license_required");
    assert.equal((await f.db.query<{ count: number }>("select count(*)::int as count from coursera_queue.payments")).rows[0].count, 3);
  } finally { await f.close(); }
});
