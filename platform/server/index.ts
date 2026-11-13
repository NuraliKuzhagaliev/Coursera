import { createApp } from "./app.js";
import { remoteStore } from "./store.js";
import { tokenVerifier } from "./auth.js";
import { z } from "zod";

const env = z.object({
  SUPABASE_URL: z.url().startsWith("https://"), SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  CQ_SERVER_KEY: z.string().regex(/^[a-f0-9]{64}$/), ADMIN_ORIGIN: z.url(),
  STRIPE_SECRET_KEY: z.string().optional(), STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_LIVE: z.enum(["true", "false"]).default("false"), PORT: z.coerce.number().default(10000)
}).parse(process.env);
if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith(env.STRIPE_LIVE === "true" ? "sk_live_" : "sk_test_")) {
  throw new Error("Stripe key does not match STRIPE_LIVE");
}
const app = await createApp({
  supabaseUrl: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, serverKey: env.CQ_SERVER_KEY,
  adminOrigin: new URL(env.ADMIN_ORIGIN).origin, stripeSecret: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET, stripeLive: env.STRIPE_LIVE === "true"
}, { rpc: remoteStore(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, env.CQ_SERVER_KEY),
  verify: tokenVerifier(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY) });
await app.listen({ host: "0.0.0.0", port: env.PORT });
