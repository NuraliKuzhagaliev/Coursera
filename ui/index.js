import { COURSERA, PARALLEL_PERMISSION, defaults } from "../src/config.js";

const byId = id => document.getElementById(id);
const labels = {
  certificate: "Сертификат получен", passed: "Зачтено", submitted: "Отправлено, результат ещё не опубликован",
  peer: "Ожидает проверки одногруппниками", manual: "Требуется моё участие", failed: "Не зачтено",
  uncertain: "Требуется моё участие", awaitingCertificate: "Зачтено · сертификат пока не найден", queued: "В очереди",
  skippedFiles: "Пропущено · требуются файлы", skippedVisual: "Пропущено · визуальное задание"
};
const modes = { idle: "Очередь ещё не запускалась.", running: "Очередь выполняется.", paused: "На паузе.", done: "Обход очереди завершён." };
function make(tag, value) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  return node;
}
function link(path, text) {
  const url = new URL(path, COURSERA);
  if (url.origin !== COURSERA || !url.pathname.startsWith("/learn/")) return make("span", text);
  const anchor = make("a", text);
  anchor.href = url.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}
function render(state = {}) {
  const { mode = "idle", current, notes, courses = {}, order = [] } = state;
  const reportOrder = [...new Set([...order, ...Object.keys(courses)])];
  const queuedCourses = new Set(order);
  byId("start").disabled = mode === "running";
  byId("single-start").disabled = mode === "running";
  byId("pause").disabled = mode !== "running";
  byId("resume").disabled = mode !== "paused";
  const progress = state.parallel && mode === "done" ? "Обход в этом профиле завершён." : modes[mode];
  byId("progress").textContent = [progress, current?.title, current?.task, current?.stage, state.reason, ...(notes || [])].filter(Boolean).join(" · ");
  const single = state.single;
  byId("single-result").textContent = single ? [
    single.title,
    single.files?.length && "Вложение ChatGPT: " + single.files.join(", "),
    single.files?.length && single.started && "Загрузка подтверждена",
    single.checked > 0 && "Галочка формы отмечена",
    labels[single.result],
    single.grade && "Оценка " + single.grade,
    single.history && "Новая запись в истории попыток: " + labels[single.history],
    single.reason
  ].filter(Boolean).join(" · ") : "";
  const result = document.createDocumentFragment();
  if (!reportOrder.length) result.append(make("p", "Курсы ещё не появились в отчёте."));
  for (const slug of reportOrder) {
    const course = courses[slug];
    const article = make("article");
    const title = make("h3");
    title.append(link(course.url, course.title));
    const parallelStatus = state.parallel && course.parallel?.wave === state.wave &&
      (course.parallel.ownership === "busy" ? "Закреплён за другим профилем" : "Обработан в другом профиле");
    const courseStatus = labels[course.status] || (queuedCourses.has(slug) ? labels.queued : "Результат ещё не получен");
    article.append(title, make("p", parallelStatus || courseStatus));
    if (!queuedCourses.has(slug)) article.append(make("p", "Сохранённая история · вне текущей очереди."));
    if (course.reason) article.append(make("p", course.reason));
    const list = make("ul");
    for (const review of course.reviews || []) {
      const item = make("li");
      item.append(link(review.url, review.title), " · Требуется моё участие");
      list.append(item);
    }
    for (const task of Object.values(course.tasks)) {
      const item = make("li");
      const peer = task.peerManual && task.status !== "passed" ?
        "Требуется моё участие — оценить работы других участников." : "";
      const status = task.pending && task.visited !== state.wave ?
        "Результат отправки уточняется" : labels[task.status];
      item.append(link(task.url, task.title), " · " + [status, task.grade && "Оценка " + task.grade, task.reason, peer].filter(Boolean).join(" · "));
      list.append(item);
    }
    if (list.childElementCount) article.append(list);
    result.append(article);
  }
  byId("report").replaceChildren(result);
}
async function send(message) {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || "Служба расширения недоступна.");
    byId("notice").textContent = {
      settings: "Настройки сохранены.", native: "Chrome успешно получил ответ от Native Messaging."
    }[message.action] || "";
  } catch (error) { byId("notice").textContent = error.message; }
}
for (const action of ["start", "pause", "resume"]) byId(action).addEventListener("click", () => void send({ action }));
byId("native").addEventListener("click", () => void send({ action: "native" }));
byId("single").addEventListener("submit", event => {
  event.preventDefault();
  void send({ action: "single", url: byId("single-url").value });
});
byId("parallel-enabled").addEventListener("change", () => {
  byId("parallel-key").disabled = !byId("parallel-enabled").checked;
  byId("parallel-key").required = byId("parallel-enabled").checked;
});
byId("settings").addEventListener("submit", async event => {
  event.preventDefault();
  const settings = {
    provider: byId("provider").value, fallback: byId("fallback").checked,
    chatRequests: byId("chat-requests").valueAsNumber, quizDelaySeconds: byId("quiz-delay").valueAsNumber,
    parallelEnabled: byId("parallel-enabled").checked,
    parallelKey: byId("parallel-key").value
  };
  try {
    if (settings.parallelEnabled && !await chrome.permissions.request(PARALLEL_PERMISSION)) {
      throw new Error("Разрешите доступ к локальному координатору, чтобы включить параллельную очередь.");
    }
    await send({ action: "settings", settings });
  } catch (error) { byId("notice").textContent = error.message; }
});
await chrome.runtime.sendMessage({ action: "status" }).catch(() => {});
const data = await chrome.storage.local.get(["state", "settings"]);
const settings = { ...defaults, ...data.settings,
  parallelEnabled: data.settings?.parallelEnabled ?? !!data.settings?.parallelKey };
byId("provider").value = settings.provider;
byId("fallback").checked = settings.fallback;
byId("chat-requests").value = settings.chatRequests;
byId("quiz-delay").value = settings.quizDelaySeconds;
byId("parallel-key").value = settings.parallelKey;
byId("parallel-enabled").checked = settings.parallelEnabled;
byId("parallel-key").disabled = !settings.parallelEnabled;
byId("parallel-key").required = settings.parallelEnabled;
byId("extension-id").textContent = chrome.runtime.id;
render(data.state);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.state) render(changes.state.newValue);
});
