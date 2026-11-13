import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Stripe from "stripe";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { makePrompt, parseAnswer, resultForCourse, Manual } from "../../src/core.js";
import { ApiError, type Rpc } from "./store.js";
import type { Identity } from "./auth.js";

export interface Config {
  supabaseUrl: string; publishableKey: string; serverKey: string; adminOrigin: string;
  stripeSecret?: string; stripeWebhookSecret?: string; stripeLive?: boolean;
}
interface Dependencies {
  rpc: Rpc;
  verify: (token: string) => Promise<Identity>;
  stripe?: Stripe;
}
const uuid = z.uuid();
const assessmentSchema = z.object({
  title: z.string().max(2000), questions: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  instructions: z.string().max(100000).optional(), peer: z.boolean().optional()
}).passthrough();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const outdated = (value: string, minimum: string) => {
  const current = value.split(".").map(Number), required = minimum.split(".").map(Number);
  return current.some((part, index) => part < required[index] && current.slice(0, index).every((part, n) => part === required[n]));
};

export async function createApp(config: Config, deps: Dependencies) {
  const app = Fastify({ bodyLimit: 524288, requestTimeout: 15000, trustProxy: (_address, hop) => hop === 0, logger: false });
  const runtimeErrors: { code: string; path: string; time: string }[] = [];
  const stripe = deps.stripe || (config.stripeSecret ? new Stripe(config.stripeSecret, { timeout: 8000, maxNetworkRetries: 1 }) : null);
  const signingKey = createHash("sha256").update(config.serverKey + "/jobs").digest();
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || origin === config.adminOrigin ||
      /^chrome-extension:\/\/[a-p]{32}$/.test(origin)),
    allowedHeaders: ["Authorization", "Content-Type", "X-CQ-Session", "X-CQ-Device", "X-CQ-Version"],
    methods: ["GET", "POST"]
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((error: any, request, reply) => {
    const status = error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 : error.statusCode === 429 ? 429 : 503;
    const code = error instanceof ApiError ? error.code : error instanceof z.ZodError ? "invalid_request" :
      error.statusCode === 429 ? "rate_limited" : "server_unavailable";
    runtimeErrors.push({ code, path: request.routeOptions.url || "", time: new Date().toISOString() });
    if (runtimeErrors.length > 100) runtimeErrors.shift();
    console.error(JSON.stringify({ code, path: request.routeOptions.url, status }));
    reply.code(status).send({ error: code });
  });
  const context = async (request: any) => {
    const match = request.headers.authorization?.match(/^Bearer (.+)$/);
    if (!match) throw new ApiError("auth_required", 401);
    const identity = await deps.verify(match[1]);
    return {
      ...identity,
      sessionToken: z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers["x-cq-session"]),
      deviceId: z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers["x-cq-device"])
    };
  };
  const authorize = async (request: any, payload: Record<string, unknown> = {}) => {
    const identity = await context(request);
    const status = await deps.rpc("authorize", { ...identity, ...payload });
    const installed = version.safeParse(request.headers["x-cq-version"]);
    if (!installed.success || outdated(installed.data, status.release.minimumVersion)) throw new ApiError("update_required");
    return { identity, status };
  };

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/config", async () => ({
    supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, adminOrigin: config.adminOrigin,
    ...await deps.rpc("config"), stripeReady: !!stripe
  }));
  app.post("/v1/session/open", async request => {
    const body = z.object({ sessionId: uuid }).parse(request.body);
    return deps.rpc("session.open", { ...await context(request), ...body });
  });
  app.post("/v1/session/close", async request => deps.rpc("session.close", await context(request)));
  app.post("/v1/license/status", async request => deps.rpc("status", await context(request)));
  app.post("/v1/license/authorize", async request => {
    const { operation } = z.object({ operation: z.enum(["submit", "open", "confirm-start", "fill"]) }).parse(request.body);
    const { status } = await authorize(request, { kind: operation });
    return status;
  });
  app.post("/v1/account/identity", async request => {
    const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.body);
    return deps.rpc("account.identity", { ...await context(request), ...body });
  });
  app.post("/v1/engine/prompt", async request => {
    const body = z.object({ assessment: assessmentSchema, requestId: z.string().regex(/^assignment-[a-f0-9-]{36}$/),
      feedback: z.string().max(50000).default(""), correction: z.string().max(10000).default("") }).parse(request.body);
    const { identity } = await authorize(request, { kind: "prompt", requestId: body.requestId.slice(11), requestHash: hash(body) });
    const job = await new SignJWT({ user: identity.userId, authSession: identity.authSession,
      requestId: body.requestId, assessment: hash(body.assessment) }).setProtectedHeader({ alg: "HS256" })
      .setIssuer("coursera-queue").setAudience("answer-validation").setIssuedAt().setExpirationTime("30m").sign(signingKey);
    return { prompt: makePrompt(body.assessment, body.requestId, body.feedback, body.correction), job };
  });
  app.post("/v1/engine/answer", async (request, reply) => {
    const body = z.object({ assessment: assessmentSchema, requestId: z.string().max(100), job: z.string().max(3000),
      reply: z.union([z.string().max(200000), z.record(z.string(), z.unknown())]) }).parse(request.body);
    const { identity } = await authorize(request, { kind: "answer" });
    let claims;
    try { ({ payload: claims } = await jwtVerify(body.job, signingKey, { algorithms: ["HS256"],
      issuer: "coursera-queue", audience: "answer-validation" })); }
    catch { throw new ApiError("job_invalid"); }
    if (claims.user !== identity.userId || claims.authSession !== identity.authSession ||
      claims.requestId !== body.requestId || claims.assessment !== hash(body.assessment)) throw new ApiError("job_invalid");
    try { return { answers: parseAnswer(body.reply, body.requestId, body.assessment) }; }
    catch (error: any) {
      return reply.code(422).send({ error: error instanceof Manual ? "manual" : "answer_invalid", message: error.message });
    }
  });
  app.post("/v1/engine/course", async request => {
    const course = z.object({ course: z.record(z.string(), z.unknown()) }).parse(request.body).course;
    await authorize(request, { kind: "course" });
    return { status: resultForCourse(course) };
  });
  app.get("/v1/admin", async request => ({
    ...await deps.rpc("admin.snapshot", await context(request)), runtimeErrors
  }));
  const changes = {
    license: z.object({ targetUser: uuid, planId: z.string().max(40), expiresAt: z.iso.datetime() }),
    revoke: z.object({ targetUser: uuid }),
    block: z.object({ targetUser: uuid, blocked: z.boolean() }),
    device: z.object({ targetUser: uuid, locked: z.boolean(), reset: z.boolean() }),
    session: z.object({ targetSession: uuid }),
    plan: z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().min(1).max(100),
      dailyQuota: z.number().int().min(1).max(10000), rpm: z.number().int().min(1).max(300),
      stripePriceId: z.string().max(100), amount: z.number().int().min(0), currency: z.string().regex(/^[a-z]{3}$/), enabled: z.boolean() }),
    release: z.object({ minimumVersion: version, latestVersion: version, notice: z.string().max(4000) })
  };
  for (const [action, schema] of Object.entries(changes)) {
    app.post("/v1/admin/" + action, async request => deps.rpc("admin." + action, {
      ...await context(request), ...schema.parse(request.body)
    }));
  }
  app.post("/v1/billing/checkout", async request => {
    if (!stripe) throw new ApiError("billing_not_configured", 503);
    const { planId } = z.object({ planId: z.string().max(40) }).parse(request.body);
    const identity = await context(request);
    const account = await deps.rpc("checkout", identity);
    const { plans } = await deps.rpc("config");
    const plan = plans.find((plan: any) => plan.id === planId && plan.enabled && plan.stripe_price_id);
    if (!plan) throw new ApiError("plan_not_configured", 400);
    let customer = account.customerId;
    if (!customer) {
      customer = (await stripe.customers.create({ email: account.email, metadata: { cq_user_id: identity.userId } },
        { idempotencyKey: "coursera-customer-" + identity.userId })).id;
      await deps.rpc("billing.customer", { ...identity, customerId: customer });
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer, line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      subscription_data: { metadata: { cq_user_id: identity.userId } },
      success_url: config.adminOrigin + "/?payment=received", cancel_url: config.adminOrigin + "/?payment=canceled"
    });
    return { url: session.url };
  });
  app.register(async webhook => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    webhook.post("/v1/billing/webhook", async (request, reply) => {
      if (!stripe || !config.stripeWebhookSecret) throw new ApiError("billing_not_configured", 503);
      let event: Stripe.Event;
      try { event = stripe.webhooks.constructEvent(request.body as Buffer,
        z.string().parse(request.headers["stripe-signature"]), config.stripeWebhookSecret); }
      catch { throw new ApiError("invalid_signature", 400); }
      if (event.livemode !== !!config.stripeLive) throw new ApiError("stripe_mode_mismatch", 400);
      const object = event.data.object as any;
      const relevant = event.type.startsWith("customer.subscription.") ||
        ["invoice.paid", "invoice.payment_failed"].includes(event.type);
      if (!relevant) return { received: true };
      const sub = object.object === "subscription" ? object.id :
        object.parent?.subscription_details?.subscription || object.subscription;
      if (typeof sub !== "string") return { received: true };
      const owner = randomUUID();
      const claimed = await deps.rpc("billing.claim", { subscriptionId: sub, eventId: event.id, owner });
      if (claimed.done) return { received: true };
      const subscription = await stripe.subscriptions.retrieve(sub, { expand: ["latest_invoice"] });
      const item = subscription.items.data[0];
      if (!item || subscription.items.data.length !== 1) throw new ApiError("unsupported_subscription", 400);
      const invoice = subscription.latest_invoice;
      await deps.rpc("billing.commit", {
        subscriptionId: sub, eventId: event.id, owner,
        customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
        priceId: item.price.id, amount: item.price.unit_amount, currency: item.price.currency,
        status: subscription.status, periodEnd: item.current_period_end,
        paid: typeof invoice === "object" && invoice !== null && invoice.status === "paid"
      });
      return reply.send({ received: true });
    });
  });
  return app;
}
