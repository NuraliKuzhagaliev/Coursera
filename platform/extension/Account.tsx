import React, { useEffect, useState } from "react";

export function AccountPanel({ send }: { send: (message: any) => Promise<any> }) {
  const [data, setData] = useState<any>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("login");
  const refresh = async () => {
    const reply = await send({ action: "auth.status" });
    if (reply.error) { setData(undefined); throw new Error(reply.error); }
    setData(reply);
  };
  useEffect(() => { refresh().catch(error => setMessage(error.message)); }, []);
  const action = async (payload: any) => {
    setBusy(true);
    setMessage("");
    try {
      const reply = await send(payload);
      if (reply.error) throw new Error(reply.error);
      if (reply.message) setMessage(reply.message);
      await refresh();
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const status = data?.status;
  return <section aria-label="Аккаунт расширения" className="account-panel">
    <h2>Аккаунт расширения</h2>
    {message && <p role="status">{message}</p>}
    {status ? <>
      <p>{status.email} · {status.active ? "Лицензия активна" : "Нужна лицензия"}</p>
      {status.active && <p>{status.plan.name} · до {new Date(status.expiresAt).toLocaleString()} · использовано {status.used} из {status.plan.daily_quota} запросов за день</p>}
      {status.release.notice && <p>{status.release.notice}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => action({ action: "auth.identity" })}>Прочитать имя и почту Coursera</button>
        <button disabled={busy} onClick={() => action({ action: "auth.portal" })}>Личный кабинет</button>
        <button disabled={busy} onClick={() => action({ action: "auth.logout" })}>Выйти</button>
      </div>
      {data.identity && <p>Coursera · {data.identity.name} · {data.identity.email}</p>}
      <p>Новый вход в другом профиле завершает предыдущую сессию расширения.</p>
      <div className="actions">{(data.plans || []).filter((plan: any) => plan.enabled).map((plan: any) =>
        <button key={plan.id} disabled={busy || !plan.stripe_price_id} onClick={() => action({ action: "auth.checkout", planId: plan.id })}>
          {plan.name}{plan.amount > 0 ? " · " + (plan.amount / 100).toFixed(2) + " " + plan.currency.toUpperCase() : " · оплата настраивается"}
        </button>)}</div>
    </> : <>
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        void action({ action: "auth." + mode, email: values.get("email"), password: values.get("password") });
        (form.elements.namedItem("password") as HTMLInputElement).value = "";
      }}>
        <label>Почта <input type="email" name="email" autoComplete="email" required maxLength={254} /></label>
        <label>Пароль <input type="password" name="password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={mode === "signup" ? 12 : 1} maxLength={200} required /></label>
        <button disabled={busy}>{mode === "login" ? "Войти" : "Зарегистрироваться"}</button>
      </form>
      <div className="actions">
        <button disabled={busy} onClick={() => setMode(mode === "login" ? "signup" : "login")}>{mode === "login" ? "Регистрация" : "Уже есть аккаунт"}</button>
        <button disabled={busy} onClick={() => action({ action: "auth.recover" })}>Восстановить пароль</button>
        <button disabled={busy} onClick={() => refresh().catch(error => setMessage(error.message))}>Проверить подключение</button>
      </div>
    </>}
  </section>;
}
