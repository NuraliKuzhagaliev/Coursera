"use client";
import React, { useEffect, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AccountPanel } from "../../extension/Account";

const API = process.env.NEXT_PUBLIC_API_ORIGIN || "";
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, "0")).join("");
let supabase: SupabaseClient;
let configuration: any;
async function setup() {
  if (!API) throw new Error("Не задан адрес API.");
  if (!supabase) {
    const response = await fetch(API + "/v1/config");
    if (!response.ok) throw new Error("Сервер недоступен.");
    configuration = await response.json();
    supabase = createClient(configuration.supabaseUrl, configuration.publishableKey, {
      auth: { storageKey: "cq-admin-auth", flowType: "pkce", detectSessionInUrl: true }
    });
  }
  return supabase;
}
async function headers() {
  const auth = await setup();
  const { data: { session } } = await auth.auth.getSession();
  if (!session) throw new Error("Войдите в аккаунт.");
  let device = localStorage.getItem("cq-admin-device");
  if (!device) { device = random(); localStorage.setItem("cq-admin-device", device); }
  return {
    Authorization: "Bearer " + session.access_token,
    "Content-Type": "application/json",
    "X-CQ-Session": localStorage.getItem("cq-admin-session") || "",
    "X-CQ-Device": device,
    "X-CQ-Version": "2.0.0"
  };
}
async function api(path: string, body?: any) {
  const response = await fetch(API + path, { method: body === undefined ? "GET" : "POST",
    headers: await headers(), body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || "Ошибка сервера.");
  return result;
}
export default function Page() {
  const [snapshot, setSnapshot] = useState<any>();
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [canReset, setCanReset] = useState(false);
  useEffect(() => {
    const requested = new URL(location.href).searchParams.get("recovery") === "1";
    setRecovery(requested);
    if (requested) setup().then(auth => auth.auth.getSession()).then(({ data }) => {
      setCanReset(!!data.session);
      history.replaceState(null, "", "/?recovery=1");
    }).catch(error => setNotice(error.message));
  }, []);
  const refresh = async () => setSnapshot(await api("/v1/admin"));
  const change = async (operation: string, body: any) => {
    setNotice("");
    try { await api("/v1/admin/" + operation, body); await refresh(); setNotice("Изменения сохранены."); }
    catch (error: any) { setNotice(error.message); }
  };
  const send = async (message: any) => {
    try {
      const auth = await setup();
      if (message.action === "auth.status") {
        const { data } = await auth.auth.getSession();
        if (!data.session || !localStorage.getItem("cq-admin-session")) return { status: null, plans: configuration.plans };
        const status = await api("/v1/license/status", {});
        if (status.role === "admin") await refresh();
        return { status, plans: configuration.plans };
      }
      if (message.action === "auth.login") {
        const { error } = await auth.auth.signInWithPassword({ email: message.email, password: message.password });
        if (error) throw error;
        localStorage.setItem("cq-admin-session", random());
        await api("/v1/session/open", { sessionId: crypto.randomUUID() });
      } else if (message.action === "auth.signup") {
        const { error } = await auth.auth.signUp({ email: message.email, password: message.password,
          options: { emailRedirectTo: location.origin + "/?confirmed=1" } });
        if (error) throw error;
        return { message: "Подтвердите почту по письму, затем войдите." };
      } else if (message.action === "auth.logout") {
        await api("/v1/session/close", {}).catch(() => {});
        await auth.auth.signOut({ scope: "local" });
        localStorage.removeItem("cq-admin-session");
        setSnapshot(undefined);
      } else if (message.action === "auth.recover") {
        setRecovery(true);
        setCanReset(false);
      } else if (message.action === "auth.identity") {
        return { message: "Имя и почта Coursera читаются кнопкой в установленном расширении." };
      } else if (message.action === "auth.checkout") {
        const { url } = await api("/v1/billing/checkout", { planId: message.planId });
        const target = new URL(url);
        if (target.protocol !== "https:" || target.hostname !== "checkout.stripe.com") throw new Error("Некорректный адрес оплаты.");
        location.assign(url);
      }
      return { ok: true };
    } catch (error: any) { return { error: error.message }; }
  };
  return <>
    <header><p>Coursera Queue</p><h1>Кабинет</h1></header>
    <AccountPanel send={send} />
    {recovery && <section><h2>Восстановление пароля</h2><form onSubmit={async event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      try {
        const auth = await setup();
        const result = canReset ? await auth.auth.updateUser({ password: String(values.get("password")) }) :
          await auth.auth.resetPasswordForEmail(String(values.get("email")), { redirectTo: location.origin + "/?recovery=1" });
        if (result.error) throw result.error;
        setNotice(canReset ? "Пароль обновлён. Войдите с новым паролем." : "Откройте письмо восстановления в этом браузере.");
      } catch (error: any) { setNotice(error.message); }
    }}>
      {canReset ? <label>Новый пароль <input name="password" type="password" minLength={12} autoComplete="new-password" required /></label> :
        <label>Почта <input name="email" type="email" autoComplete="email" required /></label>}
      <button>{canReset ? "Сохранить пароль" : "Отправить письмо"}</button>
    </form></section>}
    {notice && <p role="status">{notice}</p>}
    {snapshot && <section>
      <h2>Администрирование</h2>
      <p>Пользователей {snapshot.users.length} · активных сессий {snapshot.sessions.filter((s: any) => !s.revokedAt).length}</p>
      <button onClick={() => refresh().catch(error => setNotice(error.message))}>Обновить</button>
      <button onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = "coursera-licenses-backup.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Сохранить резервную копию данных кабинета</button>
      <div className="table-wrap"><table><thead><tr><th>Пользователь</th><th>Доступ</th><th>Действия</th></tr></thead><tbody>
        {snapshot.users.map((user: any) => <tr key={user.user_id}><td>{user.email}<br />{user.display_name}<br /><small>{user.user_id}</small></td>
          <td>{user.blocked ? "Заблокирован" : user.license_revoked ? "Лицензия отозвана" : user.role}<br />
            {(snapshot.licenses || []).filter((l: any) => l.user_id === user.user_id).map((l: any) =>
              <div key={l.source + l.subscription_id}>{l.plan_id} · {l.status} · {new Date(l.expires_at).toLocaleString()}</div>)}
            <div>Запросов сегодня {snapshot.usage.find((u: any) => u.user_id === user.user_id)?.count || 0}</div>
          </td><td><div className="actions">
            <button onClick={() => change("block", { targetUser: user.user_id, blocked: !user.blocked })}>{user.blocked ? "Разблокировать" : "Заблокировать"}</button>
            <button onClick={() => change("revoke", { targetUser: user.user_id })}>Отозвать лицензии</button>
            <button onClick={() => change("device", { targetUser: user.user_id, locked: !user.device_lock, reset: false })}>{user.device_lock ? "Снять привязку" : "Ограничить устройством"}</button>
            <button onClick={() => change("device", { targetUser: user.user_id, locked: user.device_lock, reset: true })}>Сбросить устройство</button>
          </div></td></tr>)}
      </tbody></table></div>
      <h3>Выдать или продлить лицензию</h3>
      <form onSubmit={event => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        void change("license", { targetUser: values.get("user"), planId: values.get("plan"),
          expiresAt: new Date(String(values.get("expires"))).toISOString() });
      }}>
        <label>Пользователь <select name="user">{snapshot.users.map((u: any) => <option key={u.user_id} value={u.user_id}>{u.email}</option>)}</select></label>
        <label>Тариф <select name="plan">{snapshot.plans.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Действует до <input type="datetime-local" name="expires" required /></label><button>Выдать лицензию</button>
      </form>
      <h3>Сессии</h3>
      {snapshot.sessions.map((s: any) => <p key={s.id}>
        {snapshot.users.find((u: any) => u.user_id === s.userId)?.email} · {new Date(s.lastSeen).toLocaleString()} · {s.revokedAt ? "Завершена" : "Активна"}{" "}
        {!s.revokedAt && <button onClick={() => change("session", { targetSession: s.id })}>Завершить</button>}
      </p>)}
      <h3>Тарифы и квоты</h3>
      {snapshot.plans.map((p: any) => <form key={p.id} onSubmit={event => {
        event.preventDefault(); const f = new FormData(event.currentTarget);
        void change("plan", { id: p.id, name: f.get("name"), dailyQuota: Number(f.get("quota")), rpm: Number(f.get("rpm")),
          stripePriceId: f.get("price"), amount: Number(f.get("amount")), currency: f.get("currency"), enabled: f.get("enabled") === "on" });
      }}>
        <strong>{p.id}</strong><label>Название <input name="name" defaultValue={p.name} required /></label>
        <label>Запросов в день <input name="quota" type="number" min="1" max="10000" defaultValue={p.daily_quota} required /></label>
        <label>Запросов в минуту <input name="rpm" type="number" min="1" max="300" defaultValue={p.requests_per_minute} required /></label>
        <label>Stripe Price ID <input name="price" defaultValue={p.stripe_price_id || ""} /></label>
        <label>Цена в минимальных единицах валюты <input name="amount" type="number" min="0" defaultValue={p.amount} required /></label>
        <label>Валюта <input name="currency" pattern="[a-z]{3}" defaultValue={p.currency} required /></label>
        <label><input name="enabled" type="checkbox" defaultChecked={p.enabled} /> Тариф включён</label><button>Сохранить тариф</button>
      </form>)}
      <h3>Версия расширения</h3>
      <form onSubmit={event => {
        event.preventDefault(); const f = new FormData(event.currentTarget);
        void change("release", { minimumVersion: f.get("minimum"), latestVersion: f.get("latest"), notice: f.get("notice") });
      }}>
        <label>Минимальная версия <input name="minimum" defaultValue={snapshot.release.minimumVersion} required /></label>
        <label>Последняя версия <input name="latest" defaultValue={snapshot.release.latestVersion} required /></label>
        <label>Уведомление <textarea name="notice" defaultValue={snapshot.release.notice} maxLength={4000} /></label><button>Сохранить</button>
      </form>
      <h3>Платежи</h3>
      {snapshot.payments.map((p: any) => <p key={p.event_id}>{p.subscription_id} · {p.status} · {p.amount / 100} {p.currency}</p>)}
      <h3>Журнал</h3>
      {snapshot.audit.map((a: any) => <p key={a.id}>{new Date(a.created_at).toLocaleString()} · {a.action} · {JSON.stringify(a.details)}</p>)}
      <h3>Последние ошибки текущего процесса API</h3>
      {(snapshot.runtimeErrors || []).map((e: any, index: number) => <p key={index}>{e.time} · {e.code} · {e.path}</p>)}
    </section>}
  </>;
}
