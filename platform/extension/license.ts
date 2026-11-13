import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Hold, Manual } from "../../src/core.js";
import { readIdentityFields } from "./identity";
declare const __API_ORIGIN__: string;
const API = __API_ORIGIN__;
const ALARM = "cq-license";
let client: SupabaseClient | undefined;
let configuration: any;
let refreshing: Promise<any> | undefined;
let checkedAt = 0;
let checking: Promise<any> | undefined;
let lease: any;
const messages: Record<string, string> = {
  auth_required: "Войдите в аккаунт расширения и подтвердите почту.",
  session_required: "Войдите в аккаунт расширения.",
  session_revoked: "Сессия завершена. Возможно, выполнен новый вход в другом профиле.",
  account_blocked: "Аккаунт расширения заблокирован.",
  device_locked: "Лицензия закреплена за другим устройством. Обратитесь к администратору.",
  license_required: "Нужна действующая лицензия.",
  rate_limited: "Превышена частота запросов. Попробуйте позже.",
  quota_exceeded: "Дневная квота тарифа исчерпана.",
  update_required: "Обновите расширение до разрешённой версии.",
  billing_not_configured: "Оплата пока не настроена. Обратитесь к администратору.",
  plan_not_configured: "Для этого тарифа ещё не настроена оплата."
};
const storage = {
  async getItem(key: string) {
    const value = (await chrome.storage.local.get(key))[key];
    return typeof value === "string" ? value : null;
  },
  async setItem(key: string, value: string) { await chrome.storage.local.set({ [key]: value }); },
  async removeItem(key: string) { await chrome.storage.local.remove(key); }
};
async function setup() {
  if (client) return client;
  try {
    const response = await fetch(API + "/v1/config", { signal: AbortSignal.timeout(8000), credentials: "omit" });
    if (!response.ok) throw new Error();
    configuration = await response.json();
    client = createClient(configuration.supabaseUrl, configuration.publishableKey, {
      auth: { storage, storageKey: "cq.supabase", autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" }
    });
    return client;
  } catch { throw new Hold("Сервер лицензий недоступен. Проверьте подключение и повторите."); }
}
async function session() {
  const auth = await setup();
  let { data: { session } } = await auth.auth.getSession();
  if (session && (session.expires_at || 0) * 1000 < Date.now() + 60000) {
    refreshing ??= auth.auth.refreshSession().finally(() => { refreshing = undefined; });
    const result = await refreshing;
    if (result.error) throw new Hold(messages.auth_required);
    session = result.data.session;
  }
  if (!session) throw new Hold(messages.auth_required);
  return session;
}
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, "0")).join("");
async function device() {
  const { cqDevice } = await chrome.storage.local.get("cqDevice");
  if (typeof cqDevice === "string" && /^[a-f0-9]{64}$/.test(cqDevice)) return cqDevice;
  const id = randomToken();
  await chrome.storage.local.set({ cqDevice: id });
  return id;
}
async function request(path: string, payload: unknown = {}) {
  const auth = await session();
  const { cqSession } = await chrome.storage.local.get("cqSession");
  if (!cqSession || typeof cqSession !== "object" || !("token" in cqSession) || typeof cqSession.token !== "string") {
    throw new Hold(messages.session_required);
  }
  let response: Response;
  try {
    response = await fetch(API + path, {
      method: "POST", headers: {
        Authorization: "Bearer " + auth.access_token, "Content-Type": "application/json",
        "X-CQ-Session": cqSession.token, "X-CQ-Device": await device(),
        "X-CQ-Version": chrome.runtime.getManifest().version
      }, body: JSON.stringify(payload), credentials: "omit", signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Hold("Сервер лицензий недоступен. Работа приостановлена."); }
  const result = await response.json();
  if (!response.ok) {
    if (result.error === "manual") throw new Manual(result.message);
    if (result.error === "answer_invalid") throw new Error(result.message);
    checkedAt = 0;
    lease = undefined;
    throw new Hold(messages[result.error] || "Сервер отклонил операцию. " + result.error);
  }
  return result;
}
export async function requireLicense(force = false) {
  if (!force && lease?.active && Date.now() - checkedAt < 120000) return lease;
  checking ??= request("/v1/license/authorize", { operation: "open" }).then(result => {
    if (!result.active) throw new Hold(messages.license_required);
    lease = result;
    checkedAt = Date.now();
    return result;
  }).finally(() => { checking = undefined; });
  return checking;
}
export async function authorizeMutation(operation: string) {
  const status = await request("/v1/license/authorize", { operation });
  lease = status;
  checkedAt = Date.now();
}
export const protectedPrompt = (assessment: unknown, requestId: string, feedback: string, correction: string) =>
  request("/v1/engine/prompt", { assessment, requestId, feedback, correction });
export const protectedAnswer = async (reply: unknown, requestId: string, assessment: unknown, job: string) =>
  (await request("/v1/engine/answer", { reply, requestId, assessment, job })).answers;
export const protectedCourse = async (course: unknown) => (await request("/v1/engine/course", { course })).status;

async function courseraIdentity() {
  const tab = await chrome.tabs.create({ url: "https://www.coursera.org/account-settings", active: false });
  if (!tab.id) throw new Error("Не удалось открыть настройки Coursera.");
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readIdentityFields
      }).catch(() => []);
      const identity = results[0]?.result;
      if (identity) {
        await request("/v1/account/identity", { name: identity.name });
        const value = { ...identity, readAt: new Date().toISOString() };
        await chrome.storage.local.set({ courseraIdentity: value });
        return value;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Coursera не показала однозначные поля Full name и Email address. Проверьте вход в Coursera.");
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
}
export async function handleAuthMessage(message: any) {
  const auth = await setup();
  if (message.action === "auth.login") {
    const result = await auth.auth.signInWithPassword({ email: message.email, password: message.password });
    if (result.error) throw new Error(result.error.message);
    const cqSession = { token: randomToken(), id: crypto.randomUUID() };
    await chrome.storage.local.set({ cqSession });
    const status = await request("/v1/session/open", { sessionId: cqSession.id });
    checkedAt = 0;
    await chrome.alarms.create(ALARM, { periodInMinutes: 2 });
    return { ok: true, status };
  }
  if (message.action === "auth.signup") {
    const result = await auth.auth.signUp({ email: message.email, password: message.password,
      options: { emailRedirectTo: configuration.adminOrigin + "/?confirmed=1" } });
    if (result.error) throw new Error(result.error.message);
    return { ok: true, message: "Откройте письмо подтверждения, затем войдите в расширение." };
  }
  if (message.action === "auth.logout") {
    await request("/v1/session/close").catch(() => {});
    await auth.auth.signOut({ scope: "local" });
    await chrome.storage.local.remove(["cqSession", "cq.supabase"]);
    checkedAt = 0;
    lease = undefined;
    await chrome.alarms.clear(ALARM);
    return { ok: true };
  }
  if (message.action === "auth.recover" || message.action === "auth.portal") {
    await chrome.tabs.create({ url: configuration.adminOrigin + (message.action === "auth.recover" ? "/?recovery=1" : "/") });
    return { ok: true };
  }
  if (message.action === "auth.identity") return { ok: true, identity: await courseraIdentity() };
  if (message.action === "auth.checkout") {
    const { url } = await request("/v1/billing/checkout", { planId: message.planId });
    const destination = new URL(url);
    if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Некорректная ссылка оплаты.");
    await chrome.tabs.create({ url });
    return { ok: true };
  }
  if (message.action === "auth.status") {
    const { data } = await auth.auth.getSession();
    if (!data.session) return { ok: true, status: null, plans: configuration.plans };
    const status = await request("/v1/license/status");
    const { courseraIdentity } = await chrome.storage.local.get("courseraIdentity");
    return { ok: true, status, identity: courseraIdentity, plans: configuration.plans };
  }
  throw new Error("Неизвестная операция аккаунта.");
}
export function monitorLicense(onFailure: (error: Error) => Promise<void>) {
  const verify = async () => {
    checkedAt = 0;
    const { cqSession } = await chrome.storage.local.get("cqSession");
    if (!cqSession) return;
    await chrome.alarms.create(ALARM, { periodInMinutes: 2 });
    await requireLicense(true);
  };
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void requireLicense(true).catch(onFailure);
  });
  chrome.runtime.onStartup.addListener(() => { void verify().catch(onFailure); });
  chrome.runtime.onInstalled.addListener(() => { void verify().catch(onFailure); });
  globalThis.addEventListener("online", () => { void verify().catch(onFailure); });
  void verify().catch(onFailure);
}
