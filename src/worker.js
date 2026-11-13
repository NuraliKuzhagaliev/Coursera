import { COURSERA, LEARNING, PARALLEL_ORIGIN, PROVIDERS, defaults } from "./config.js";
import { Manual, Hold, parseAnswer, makePrompt, confirmedResult, resultForCourse } from "./core.js";
import { probeNative } from "./files.js";

const ALARM = "coursera-queue";
const initial = { schema: 2, mode: "idle", wave: 0, courses: {}, order: [], discovery: false, notes: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyOf = url => new URL(url).pathname.split("/").slice(0, 5).join("/");
const quizRoutes = ["assignment-submission", "quiz", "assignment"];
function taskKeys(key) {
  const [, , course, route, item] = key.split("/");
  return quizRoutes.includes(route) ? quizRoutes.map(type => "/learn/" + course + "/" + type + "/" + item) : [key];
}
const normalized = text => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const finishedCourse = course => ["certificate", "awaitingCertificate", "passed"].includes(course.status);
const restartReason = "Chrome был закрыт. Нажмите «Продолжить», чтобы сверить незавершённые отправки и возобновить очередь.";
let state, settings, loaded, running, courseraTab;

function load() {
  return loaded ??= Promise.all([chrome.storage.local.get(["state", "settings"]),
    chrome.storage.session.get(["courseraTab", "runningWave"])]).then(async ([data, session]) => {
    state = data.state || structuredClone(initial);
    settings = { provider: data.settings?.provider || defaults.provider, fallback: !!data.settings?.fallback,
      chatRequests: data.settings?.chatRequests ?? defaults.chatRequests,
      quizDelaySeconds: data.settings?.quizDelaySeconds ?? defaults.quizDelaySeconds,
      parallelEnabled: data.settings?.parallelEnabled ?? !!data.settings?.parallelKey,
      parallelKey: data.settings?.parallelKey || "", parallelWorker: data.settings?.parallelWorker };
    courseraTab = session.courseraTab;
    if (state.schema !== 2) {
      for (const course of Object.values(state.courses)) {
        for (const task of Object.values(course.tasks)) if (task.status === "peer") task.status = "submitted";
        if (course.status === "peer") course.status = "submitted";
      }
      state.schema = 2;
      await save();
    }
    if (state.mode === "running" && session.runningWave !== state.wave) {
      state.mode = "paused";
      state.reason = restartReason;
      await save();
    }
  });
}
const save = () => chrome.storage.local.set({ state });
async function stage(value) {
  if (state.current && state.current.stage !== value) {
    state.current.stage = value;
    await save();
  }
}
function checkpoint() {
  if (state.mode !== "running") throw new Hold("На паузе");
}
function courseraUrl(path) {
  const url = new URL(path, COURSERA);
  if (url.origin !== COURSERA || !/^\/(?:my-learning|learn|account\/accomplishments)(?:\/|$)/.test(url.pathname)) {
    throw new Manual("Неподдерживаемая ссылка Coursera.");
  }
  return url.href;
}
async function script(tab, filename, invoke, args, injectImmediately = false) {
  const options = { target: { tabId: tab }, injectImmediately };
  await chrome.scripting.executeScript({ ...options, files: ["src/" + filename] });
  const [entry] = await chrome.scripting.executeScript({ ...options, func: invoke, args });
  if (entry?.error) throw new Error(String(entry.error));
  return entry?.result ?? null;
}
const callCoursera = (tab, action, args = {}) => script(tab, "coursera.js", (action, args) => {
  return globalThis.queueCoursera(action, args).then(value => ({ value }), error => ({ error: error.message }));
}, [action, args], ["grades", "enroll", "catalog-ready", "catalog", "tab", "next", "read", "open", "confirm-start"].includes(action)).then(result => {
  if (!result || result.error) throw new Error(result?.error || "Страница Coursera сменилась.");
  return result.value;
});
const callProvider = (tab, provider, action, data) => script(tab, "providers.js", (provider, action, data) => {
  return globalThis.queueProvider(provider, action, data).then(value => ({ value }), error => ({ error: error.message, code: error.code }));
}, [provider, action, data]).then(result => {
  if (!result || result.error) throw Object.assign(new Error(result?.error || "Страница модели сменилась."), { code: result?.code });
  return result.value;
});
async function navigate(path) {
  checkpoint();
  const url = courseraUrl(path);
  let tab = courseraTab && await chrome.tabs.get(courseraTab).catch(() => null);
  if (tab && !tab.url?.startsWith(COURSERA + "/")) tab = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
    courseraTab = tab.id;
    await chrome.storage.session.set({ courseraTab });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
  return tab.id;
}
const pageFingerprint = page => JSON.stringify([page.items || page.tasks, page.next, page.page]);
async function pages(tab, read) {
  const seen = new Set();
  const combined = [];
  for (let index = 0; index < 80; index++) {
    checkpoint();
    const page = await read(tab, seen, combined.at(-1));
    const fingerprint = pageFingerprint(page);
    if (seen.has(fingerprint) || page.truncated) throw new Error("Не удалось подтвердить конец списка. Coursera повторяет страницу или продолжает загрузку.");
    seen.add(fingerprint);
    combined.push(page);
    if (!page.next) return combined;
    if (typeof page.next === "string") tab = await navigate(page.next);
    else await callCoursera(tab, "next");
  }
  throw new Error("Превышен предел обхода страниц списка.");
}

async function waitForCatalog(tab, mode, path, label, accepts) {
  const expected = new URL(path, COURSERA);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await chrome.tabs.get(tab);
    if (current.url && !current.pendingUrl) {
      const url = new URL(current.url);
      if (url.origin === COURSERA && /^\/(?:login|signup)(?:\/|$)/.test(url.pathname)) {
        throw new Hold("Coursera: войдите в аккаунт и нажмите «Продолжить».");
      }
      if (url.origin === COURSERA && url.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") &&
          [...expected.searchParams].every(([name, value]) => url.searchParams.get(name) === value)) {
        const view = await callCoursera(tab, "catalog-ready", { mode }).catch(error => {
          if (/требуется вход/.test(error.message)) throw new Hold(error.message);
          return null;
        });
        if (view && accepts(view)) return;
      }
    }
    await sleep(450);
  }
  const page = expected.searchParams.get("page");
  throw new Error("Coursera не показала содержимое «" + label + "»" +
    (page ? ", страница " + page : "") + " за 30 секунд.");
}

async function catalogPages(mode, view) {
  const path = view?.href || new URL(LEARNING).pathname;
  const label = mode === "certificates" ? "Сертификаты" :
    view?.key === "COMPLETED" ? "Завершённые" : view?.label || "В процессе";
  const tab = await navigate(path);
  const tabLabel = view && !view.href ? view.label : null;
  if (tabLabel) {
    await waitForCatalog(tab, "courses", path, label, page => page.tabs.some(item => item.label === tabLabel));
    checkpoint();
    await callCoursera(tab, "tab", view);
  }
  return pages(tab, async (id, _seen, previous) => {
    const target = typeof previous?.next === "string" ? previous.next : path;
    await waitForCatalog(id, mode, target, label, page => page.ready &&
      (!tabLabel || page.selected === tabLabel) && (!view?.key || page.selectedKey === view.key) &&
      page.snapshot !== previous?.snapshot);
    checkpoint();
    return callCoursera(id, "catalog", { mode });
  });
}

async function optionalCatalog(mode, view) {
  try {
    return await catalogPages(mode, view);
  } catch (error) {
    if (error instanceof Hold) throw error;
    state.notes.push(error.message);
    return null;
  }
}

async function scanCourses() {
  state.current = { title: "Моё обучение" };
  await save();
  const root = new URL(LEARNING).pathname;
  const first = await catalogPages("courses");
  const items = first.flatMap(page => page.items);
  const views = [...new Map(first.flatMap(page => page.tabs).map(view => [view.label, view])).values()];
  const certificates = views.find(view => /certificates|сертификаты/i.test(view.label));
  for (const view of views.filter(view => view !== certificates && !view.selected && view.href !== root)) {
    const extra = await optionalCatalog("courses", view);
    if (extra) items.push(...extra.flatMap(page => page.items));
  }
  if (!items.length && !first.some(page => page.empty)) throw new Error("Список курсов не распознан.");
  let certs = [];
  let certificatePages = null;
  if (certificates) {
    certificatePages = await optionalCatalog("certificates", certificates);
    if (certificatePages) certs = certificatePages.flatMap(page => page.items);
  } else {
    state.notes.push("Вкладка сертификатов не распознана. Дополнительно проверяется явная ссылка в карточке и Grades.");
  }
  const deduped = new Map();
  for (const item of items) {
    if (Object.hasOwn(Object.prototype, item.slug)) continue;
    if (!deduped.has(item.slug) || item.certificate) deduped.set(item.slug, item);
  }
  const frequencies = new Map();
  for (const item of deduped.values()) {
    const name = normalized(item.title);
    frequencies.set(name, (frequencies.get(name) || 0) + 1);
  }
  for (const item of deduped.values()) {
    const course = state.courses[item.slug] ||= { ...item, tasks: {} };
    course.title = item.title;
    const name = normalized(item.title);
    if (item.certificate || certs.some(cert => cert.slug === item.slug ||
        (cert.title && normalized(cert.title) === name && frequencies.get(name) === 1))) {
      course.status = "certificate";
      course.reason = "";
    }
  }
  state.order = [...new Set([...deduped.keys(), ...state.order.filter(slug =>
    state.parallelCourse?.slug === slug || finishedCourse(state.courses[slug]) ||
    Object.values(state.courses[slug].tasks).some(task => task.pending))])];
  state.certificates = certificatePages ? certificates : null;
  state.discovery = true;
  await save();
}

const isGrades = (path, course) => ["/home/grades", "/home/assignments"].some(suffix =>
  path === course.url + suffix || path.startsWith(course.url + suffix + "/"));

async function waitCourseView(tab, course, accepts, afterEnroll = false) {
  for (let step = 0; step < 36; step++) {
    checkpoint();
    const current = await chrome.tabs.get(tab);
    if (current.url && !current.pendingUrl) {
      const url = new URL(current.url);
      if (url.origin === COURSERA && /^\/(?:login|signup)(?:\/|$)/.test(url.pathname)) {
        throw new Hold("Coursera: войдите в аккаунт и нажмите «Продолжить».");
      }
      if (afterEnroll && (url.origin !== COURSERA || /\/(?:checkout|payment|subscribe)(?:\/|$)/i.test(url.pathname))) {
        throw new Manual("Coursera открыла отдельную страницу оформления записи.");
      }
      if (url.origin === COURSERA && (url.pathname === course.url || url.pathname.startsWith(course.url + "/"))) {
        const page = await callCoursera(tab, "grades").catch(error => {
          if (/требуется вход/.test(error.message)) throw new Hold(error.message);
          return null;
        });
        if (page && afterEnroll && page.dialog) throw new Manual("Coursera показала дополнительное окно записи.");
        if (page && accepts(page)) return page;
      }
    }
    await sleep(450);
  }
  throw new Manual("Coursera не показала готовую таблицу Grades или доступный переход к ней вовремя.");
}

async function scanGrades(course, allowEnroll = false) {
  let tab = await navigate(course.url + "/home/assignments");
  const isReady = page => isGrades(page.path, course) && page.ready;
  const canOpen = page => !isGrades(page.path, course) && page.gradesLink;
  const first = await waitCourseView(tab, course, page => isReady(page) || canOpen(page) || page.enroll);
  let ready = first;
  if (first.enroll) {
    if (first.enroll !== "plus" || !allowEnroll) {
      throw new Manual("Coursera требует записи на курс. Автоматическая запись доступна для подтверждённого Coursera Plus.");
    }
    if (!first.activePlus) throw new Manual("Coursera показывает Enroll, но активный Plus на странице курса не подтверждён.");
    if (course.enrollAttemptWave === state.wave) {
      throw new Manual("Запись уже запускалась в этой очереди. Coursera пока не открыла курс.");
    }
    checkpoint();
    course.enrollAttemptWave = state.wave;
    await save();
    checkpoint();
    await callCoursera(tab, "enroll", { slug: course.slug });
    ready = await waitCourseView(tab, course, page => isReady(page) || canOpen(page), true);
  }
  if (!isReady(ready)) {
    if (!ready.gradesLink || !isGrades(new URL(ready.gradesLink, COURSERA).pathname, course)) {
      throw new Manual("В курсе не найдена ссылка Grades.");
    }
    tab = await navigate(ready.gradesLink);
    ready = await waitCourseView(tab, course, isReady);
  }
  const data = await pages(tab, (id, seen) => seen.size ?
    waitCourseView(id, course, page => isReady(page) && !seen.has(pageFingerprint(page))) : ready);
  return { cert: data.some(page => page.cert), tasks: data.flatMap(page => page.tasks),
    reviews: [...new Map(data.flatMap(page => page.reviews).map(review => [review.title, review])).values()] };
}
async function recheckCertificate(course) {
  const view = state.certificates;
  if (!view) return;
  const certificates = (await catalogPages("certificates", view)).flatMap(page => page.items);
  const title = normalized(course.title);
  const unique = state.order.filter(slug => normalized(state.courses[slug].title) === title).length === 1;
  if (certificates.some(cert => cert.slug === course.slug || (unique && cert.title && normalized(cert.title) === title))) {
    course.status = "certificate";
    course.reason = "";
  }
}
function reconcile(course, grades, initialize = false) {
  if (grades.cert) {
    course.status = "certificate";
    course.reason = "";
    return;
  }
  course.reviews = grades.reviews;
  if (initialize) course.taskOrder = [];
  for (const row of grades.tasks) {
    const task = course.tasks[row.key] ||= { ...row, status: "queued" };
    if (initialize && !course.taskOrder.includes(row.key)) course.taskOrder.push(row.key);
    const old = task.gradeStatus;
    task.gradeStatus = row.status;
    task.peer = row.peer;
    task.peerManual = row.peerManual;
    if (row.status === "passed" || (!task.pending && ["peer", "submitted", "failed"].includes(row.status))) {
      task.status = row.status;
      task.reason = row.status === "failed" ? "Проходной балл не набран." : "";
      if (row.grade) task.grade = row.grade;
      if (row.status === "passed") delete task.pending;
    } else if (!task.pending && old && old !== row.status && ["submitted", "peer", "passed"].includes(task.status)) {
      task.status = "queued";
    }
  }
  if (initialize) for (const task of Object.values(course.tasks)) {
    if ((task.pending || ["peer", "submitted"].includes(task.status)) && !course.taskOrder.includes(task.key)) {
      course.taskOrder.push(task.key);
    }
  }
}

async function providerTab(provider) {
  const tabs = await chrome.tabs.query({ url: PROVIDERS[provider] + "/*" });
  if (!tabs.length) throw new Error("Откройте вкладку и войдите в аккаунт.");
  const { chatgptTab } = provider === "chatgpt" ? await chrome.storage.session.get("chatgptTab") : {};
  return (tabs.find(tab => tab.id === chatgptTab) || tabs.find(tab => tab.active && new URL(tab.url).pathname === "/") ||
    tabs.find(tab => /^\/(?:app)?\/?$/.test(new URL(tab.url).pathname)) ||
    tabs.find(tab => tab.active) || tabs[0]).id;
}

const modelName = provider => provider === "chatgpt" ? "ChatGPT" : "Gemini";
const modelProviders = () => settings.provider === "chatgpt" && settings.fallback ? ["chatgpt", "gemini"] : [settings.provider];

async function chatUsage(tabId) {
  const [tab, { chatgptUsage }] = await Promise.all([
    chrome.tabs.get(tabId), chrome.storage.session.get("chatgptUsage")
  ]);
  const path = tab.url ? new URL(tab.url).pathname : null;
  const sameChat = chatgptUsage?.tabId === tabId && (chatgptUsage.path === path ||
    (chatgptUsage.path === "/" && path && /\/c\/[^/]+/.test(path)));
  return { tab, path, count: sameChat ? chatgptUsage.count : 0 };
}

async function countChatRequest(tabId) {
  const { path, count } = await chatUsage(tabId);
  await chrome.storage.session.set({ chatgptUsage: { tabId, path, count: count + 1 } });
}

async function freshChat(previous) {
  await stage("ChatGPT · открываю новый чат");
  checkpoint();
  const { id } = await chrome.tabs.create({ windowId: previous.windowId, url: PROVIDERS.chatgpt + "/", active: false });
  await chrome.storage.session.set({ chatgptTab: id, chatgptUsage: { tabId: id, path: "/", count: 0 } });
  const deadline = Date.now() + 15000;
  let reason = "Страница нового чата не открылась.";
  while (Date.now() < deadline) {
    checkpoint();
    const tab = await chrome.tabs.get(id);
    if (tab.url && !tab.pendingUrl) {
      const url = new URL(tab.url);
      if (url.origin === PROVIDERS.chatgpt && url.pathname === "/") {
        try {
          await modelRead(callProvider(id, "chatgpt", "ready", {}), Math.min(5000, deadline - Date.now()));
          return id;
        } catch (error) {
          if (["conversationLimit", "serviceLimit"].includes(error.code) || /требуется вход/i.test(error.message)) throw error;
          reason = error.message;
        }
      } else if (/\/(?:auth\/login|login|signin)(?:\/|$)/i.test(url.pathname)) {
        throw new Error("В новом чате требуется вход в ChatGPT.");
      }
    }
    await sleep(450);
  }
  throw new Error("Новый чат ChatGPT не готов. " + reason);
}

async function taskModelTab(provider) {
  let id = await providerTab(provider);
  if (provider === "chatgpt" && settings.chatRequests > 0) {
    const { tab, count } = await chatUsage(id);
    if (count >= settings.chatRequests) id = await freshChat(tab);
  }
  return { id, renewed: false };
}

async function withChatRecovery(provider, tab, operation) {
  try {
    return await operation(tab.id);
  } catch (error) {
    if (provider !== "chatgpt" || tab.renewed || !["conversationLimit", "serviceLimit", "replyStalled"].includes(error.code)) throw error;
    const previous = await chrome.tabs.get(tab.id);
    if (error.code === "serviceLimit" && !/\/c\/[^/]+/.test(previous.url ? new URL(previous.url).pathname : "")) throw error;
    tab.renewed = true;
    tab.id = await freshChat(previous);
    return operation(tab.id);
  }
}

async function readyModel() {
  await stage("Проверяю вкладку модели перед началом задания");
  const providers = modelProviders();
  const failures = [];
  for (const [index, provider] of providers.entries()) {
    checkpoint();
    try {
      const tab = await taskModelTab(provider);
      await withChatRecovery(provider, tab, id => modelRead(callProvider(id, provider, "ready", {}), 30000));
      return { tab, providers: providers.slice(index) };
    } catch (error) {
      if (error instanceof Hold) throw error;
      failures.push(modelName(provider) + ": " + error.message);
    }
  }
  throw new Hold("Перед началом задания: " + failures.join(" · "));
}

const replyTimeout = { waiting: 180000, generating: 300000 };
const stalledReply = message => Object.assign(new Error(message), { code: "replyStalled" });

async function modelRead(promise, timeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(stalledReply("Вкладка модели перестала отвечать.")), timeout);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReply(tab, provider, requestId) {
  const label = modelName(provider);
  const phases = {
    waitingRequest: ["проверяю отправку запроса", "не показывает отправленный запрос текущего задания"],
    waitingAnswer: ["ожидаю начало ответа", "не начал отвечать на запрос"],
    generating: ["ответ генерируется", "перестал показывать прогресс генерации"],
    waitingFinish: ["проверяю завершение ответа", "не показал признак завершения ответа"],
    settling: ["читаю завершённый ответ", "показывает ответ, но его содержимое не стабилизировалось"]
  };
  let previous, lastProgress = Date.now();
  const seenPhases = new Set();
  while (true) {
    checkpoint();
    const { phase, reply, progressed } = await modelRead(callProvider(tab, provider, "poll", { id: requestId }), 30000);
    if (reply) return reply;
    if (progressed || !seenPhases.has(phase)) lastProgress = Date.now();
    seenPhases.add(phase);
    if (previous !== phase) {
      previous = phase;
      await stage(label + " · " + phases[phase][0]);
    }
    const timeout = phase === "generating" ? replyTimeout.generating : replyTimeout.waiting;
    if (Date.now() - lastProgress >= timeout) {
      throw stalledReply(phases[phase][1] + " в течение " + Math.round(timeout / 60000) + " мин.");
    }
    await sleep(1500);
  }
}

async function ask(assessment, feedback, model) {
  const sources = model?.providers || modelProviders();
  const failures = [];
  for (const [index, provider] of sources.entries()) {
    try {
      const tab = index === 0 && model ? model.tab : await taskModelTab(provider);
      let correction = "";
      let issue = "";
      for (let turn = 0; turn < 2; turn++) {
        checkpoint();
        const { requestId, raw } = await withChatRecovery(provider, tab, async id => {
          checkpoint();
          const requestId = "assignment-" + crypto.randomUUID();
          const data = { id: requestId, prompt: makePrompt(assessment, requestId, feedback, correction) };
          if (data.prompt.length > 100000) throw new Manual("Условие превышает лимит одного запроса расширения.");
          await stage(modelName(provider) + " · отправляю запрос");
          await callProvider(id, provider, "send", data);
          if (provider === "chatgpt") await countChatRequest(id);
          return { requestId, raw: await waitForReply(id, provider, requestId) };
        });
        await stage("Проверяю ответ модели");
        try {
          return parseAnswer(raw, requestId, assessment);
        } catch (error) {
          if (error instanceof Manual || error instanceof Hold) throw error;
          issue = correction = error.message;
        }
      }
      throw new Manual("Ответ не прошёл повторную проверку. " + issue);
    } catch (error) {
      if (error instanceof Manual || error instanceof Hold) throw error;
      failures.push(modelName(provider) + ": " + error.message);
      if (sources.length > 1) {
        state.notes = [...new Set([...state.notes, failures.at(-1)])].slice(-20);
        await save();
      }
    }
  }
  throw new Hold(failures.join(" · "));
}

async function readMaterials(tab, args) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    checkpoint();
    let result;
    try { result = await callCoursera(tab, "materials", args); }
    catch (error) {
      if (!/страниц[ау] .*сменилась|Execution context|frame was removed|другую страницу задания/i.test(error.message)) {
        throw new Manual("Чтение инструкций Coursera: " + error.message);
      }
    }
    if (result) return result;
    await sleep(350);
  }
  throw new Manual("Coursera не показала инструкции текущего задания.");
}

async function waitTaskView(tab, args, accepts, errorMessage) {
  const deadline = Date.now() + 25000;
  let lastView;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await chrome.tabs.get(tab);
    if (current.url && !current.pendingUrl) {
      const url = new URL(current.url);
      if (url.origin === COURSERA && /^\/(?:login|signup)(?:\/|$)/i.test(url.pathname)) {
        throw new Hold("Coursera: войдите в аккаунт и нажмите «Продолжить».");
      }
      if (url.origin === COURSERA && args.keys.includes(keyOf(url))) {
        const view = await callCoursera(tab, "read", args).catch(error => {
          if (/требуется вход/.test(error.message)) throw new Hold(error.message);
          return null;
        });
        if (view) {
          lastView = view;
          if (await accepts(view)) return view;
        }
      }
    }
    await sleep(450);
  }
  throw new Manual(typeof errorMessage === "function" ? errorMessage(lastView) : errorMessage);
}

const readyForAnswers = view => view.ready && !view.startDialog;
const startBlocked = view => view.reason || view.fileReason || view.visualReason;

async function startAttempt(tab, args, view, kind) {
  await stage("Жду форму после начала задания");
  if (!view.startDialog) {
    checkpoint();
    await callCoursera(tab, "open", { ...args, kind });
  }
  view = await waitTaskView(tab, args, current => readyForAnswers(current) || current.startDialog || startBlocked(current),
    current => current ? "После начала не удалось распознать форму. " + (current.formIssue || "") :
      "После начала не удалось открыть страницу текущего задания.");
  if (readyForAnswers(view) || startBlocked(view)) return view;

  await stage("Проверяю диалог начала задания");
  let confirmed = false;
  return waitTaskView(tab, args, async current => {
    if (readyForAnswers(current) || startBlocked(current)) return true;
    if (current.startDialog && !confirmed) {
      checkpoint();
      confirmed = await callCoursera(tab, "confirm-start", args).catch(error => {
        if (!/страниц[ау] .*сменилась|Execution context|frame (?:was )?removed|другую страницу задания/i.test(error.message)) throw error;
        return false;
      });
    }
    return false;
  }, current => current?.startDialog && !confirmed ? "Диалог начала задания остался открыт. Кнопка подтверждения недоступна." :
    "После начала не удалось распознать форму ответов. " + (current?.formIssue || ""));
}

async function readTask(task, { history = false } = {}) {
  const tab = await navigate(task.url);
  const route = task.key.split("/")[3];
  const args = { keys: taskKeys(task.key), peer: task.peer, allowTimed: !task.peer && quizRoutes.includes(route) };
  let view = await waitTaskView(tab, args, value => value.ready || value.open || value.startDialog || value.retry ||
    value.historyLink || value.feedbackLink || value.status || startBlocked(value) || value.peerManual,
  "Coursera не показала страницу задания, форму или историю попыток.");
  if (history && (view.historyLink || view.feedbackLink) && !view.ready && !view.reason) {
    await callCoursera(tab, "open", { ...args, kind: view.historyLink ? "history" : "feedback" });
    const detailed = await waitTaskView(tab, args, current => current.history || current.feedback ||
      current.ready || startBlocked(current) || (current.status && current.status !== view.status),
    "Coursera не показала историю попыток или обратную связь.").catch(error => {
      if (!(error instanceof Manual) || !confirmedResult(view)) throw error;
      return { ...view, historyIssue: error.message };
    });
    view = {
      ...detailed, status: detailed.status || view.status, count: detailed.count ?? view.count,
      attempt: detailed.attempt || view.attempt, remaining: detailed.remaining ?? view.remaining,
      cooldown: detailed.cooldown || view.cooldown, peerManual: detailed.peerManual || view.peerManual,
      history: detailed.history || view.history, grade: detailed.grade || view.grade,
      fileReason: detailed.fileReason || view.fileReason, visualReason: detailed.visualReason || view.visualReason
    };
  }
  return { tab, args, view };
}

function record(task, result, view) {
  task.status = result;
  if (view.grade) task.grade = view.grade;
  task.peerManual ||= view.peerManual;
  task.reason = result === "failed" ? "Проходной балл не набран." : "";
  delete task.pending;
  delete task.quizTiming;
}

function newHistoryStatus(history, baseline) {
  if (!history || !baseline) return null;
  const changed = (history.attempt && history.attempt !== baseline.attempt) ||
    (Number.isInteger(history.count) && Number.isInteger(baseline.count) && history.count > baseline.count);
  return changed && ["passed", "submitted", "peer", "failed"].includes(history.status) ? history.status : null;
}

async function recover(course, task) {
  const grades = await scanGrades(course);
  const row = grades.tasks.find(item => item.key === task.key);
  reconcile(course, grades);
  if (!task.pending || course.status === "certificate") return;
  let result = row && confirmedResult({ status: row.status }, task.pending);
  let view = { peerManual: row?.peerManual, grade: row?.grade };
  if (!result) {
    ({ view } = await readTask(task, { history: true }));
    result = confirmedResult(view, task.pending);
  }
  if (result) record(task, result, view);
  else if (task.pending.issue === "Submit: Проверка перед Submit не прошла." &&
      !view.processing && (view.ready || view.open)) {
    // This older error was returned exclusively before clicking Submit.
    delete task.pending;
    task.status = "queued";
    task.reason = "";
    await save();
    return true;
  } else {
    task.status = "uncertain";
    task.reason = [task.pending.issue,
      "Отправка могла состояться. Grades и доступная история попыток не подтвердили результат. Проверьте задание вручную."]
      .filter(Boolean).join(" ");
  }
}

function skipTask(task, view) {
  const reason = view.fileReason || view.visualReason;
  if (!reason) return false;
  task.status = view.fileReason ? "skippedFiles" : "skippedVisual";
  task.reason = reason;
  return true;
}

const submitProblem = {
  fields: "Введённые ответы изменились или не прошли сверку.",
  checkbox: "Обязательная галочка осталась недоступной или не отмечена.",
  button: "Кнопка Submit осталась недоступной после сверки."
};

async function cancelBeforeSubmit(task, single, reason) {
  delete task.pending;
  task.status = "manual";
  task.reason = reason;
  if (single) {
    delete single.started;
    delete single.baseline;
    delete single.checked;
  }
  await save();
}

async function processTask(course, task, single) {
  if (task.pending && !(await recover(course, task))) return;
  if (["passed", "failed", "skippedFiles", "skippedVisual"].includes(task.status)) return;
  if (task.gradeStatus === "failed") {
    record(task, "failed", {});
    return;
  }
  if (task.gradeStatus === "locked") throw new Manual("В Grades задание заблокировано.");
  const singleQuiz = single?.kind === "quiz";
  let { tab, args, view } = await readTask(task, { history: true });
  const existing = confirmedResult(view);
  if (existing) {
    record(task, existing, view);
    return;
  }
  if (["submitted", "peer"].includes(task.status)) return;
  if (skipTask(task, view)) return;
  if (view.reason) throw new Manual(view.reason);
  if (view.peerManual && !view.ready && !view.open) throw new Manual("Coursera просит оценить работы других участников.");
  if (view.retry && !view.open && !view.startDialog && !view.ready) {
    throw new Manual("Coursera предлагает повторную попытку. Итог предыдущей попытки не удалось прочитать.");
  }
  if (view.cooldown) throw new Manual("Coursera показывает ограничение по времени: " + view.cooldown);
  if (view.remaining === 0) throw new Manual("Coursera показывает, что попытки закончились.");
  const baseline = { status: existing || task.gradeStatus, attempt: view.attempt, count: view.count,
    first: view.count === 0 || task.gradeStatus === "open" };
  const feedback = view.feedback;
  let model;
  if (!readyForAnswers(view)) {
    if (!view.open && !view.startDialog) throw new Manual("Форма и безопасная кнопка начала задания не распознаны.");
    if (args.allowTimed || singleQuiz) model = await readyModel();
    view = await startAttempt(tab, args, view, "open");
  }
  if (skipTask(task, view)) return;
  if (view.reason || !view.ready || view.unsupported) throw new Manual(view.reason || "Форма содержит неподдерживаемые поля или кнопки.");
  const quiz = singleQuiz || (!task.peer && (/\bquiz\b|квиз/i.test(task.title) ||
    view.assessment.questions.some(question => question.options.length)));
  if (quiz) {
    const timing = task.quizTiming;
    const changedAttempt = timing?.attempt && view.attempt && timing.attempt !== view.attempt;
    const changedCount = Number.isInteger(timing?.count) && Number.isInteger(view.count) && timing.count !== view.count;
    if (!Number.isFinite(timing?.openedAt) || changedAttempt || changedCount) {
      task.quizTiming = { openedAt: Date.now(), attempt: view.attempt, count: view.count };
      await save();
    }
  }
  await stage("Читаю инструкции Coursera");
  const materials = await readMaterials(tab, args);
  if (skipTask(task, materials)) return;
  if (materials.switched) {
    checkpoint();
    await callCoursera(tab, "submission-tab", args);
    view = await waitTaskView(tab, args, value => value.ready || startBlocked(value),
      "После чтения Instructions Coursera не вернула форму My submission.");
    if (skipTask(task, view)) return;
    if (view.reason || view.unsupported) throw new Manual(view.reason || "Форма сдачи изменилась после чтения инструкций.");
  }
  const assessment = view.assessment;
  if (singleQuiz && task.peer) {
    throw new Manual("В режиме одного квиза нужна форма с автоматической оценкой.");
  }
  assessment.title = materials.title || assessment.title;
  assessment.instructions = [materials.instructions, assessment.instructions].filter(Boolean).join("\n");
  const answers = await ask(assessment, feedback, model);
  await stage("Заполняю форму Coursera");
  const expected = { nonce: crypto.randomUUID(), key: assessment.key, signature: assessment.signature, allowTimed: args.allowTimed };
  const prepared = { ...args, expected, answers };
  checkpoint();
  try { await callCoursera(tab, "fill", prepared); }
  catch (error) { throw new Manual("Заполнение формы: " + error.message); }
  if (quiz) {
    let remaining = task.quizTiming.openedAt + settings.quizDelaySeconds * 1000 - Date.now();
    while (remaining > 0) {
      checkpoint();
      await stage("Ответ готов · до отправки осталось " + Math.ceil(remaining / 1000) + " с");
      await sleep(Math.min(5000, remaining));
      remaining = task.quizTiming.openedAt + settings.quizDelaySeconds * 1000 - Date.now();
    }
  }
  let verification;
  for (let step = 0; step < 12; step++) {
    checkpoint();
    try { verification = await callCoursera(tab, "verify", prepared); }
    catch (error) { throw new Manual("Проверка перед Submit: " + error.message); }
    if (verification.ready) break;
    await sleep(500);
  }
  if (!verification?.ready) throw new Manual(submitProblem[verification?.step] || "Проверка перед Submit не завершилась.");
  await stage("Отправляю задание в Coursera");
  checkpoint();
  task.pending = { baseline, started: new Date().toISOString() };
  if (single) {
    single.checked = verification.checked;
    single.started = task.pending.started;
    single.baseline = baseline;
  }
  task.status = "uncertain";
  task.reason = "Результат отправки проверяется.";
  await save();
  if (state.mode !== "running") {
    await cancelBeforeSubmit(task, single, "Пауза до нажатия Submit.");
    checkpoint();
  }
  let submission;
  try {
    submission = await callCoursera(tab, "submit", prepared);
    if (submission?.issue) task.pending.issue = submission.issue;
  }
  catch (error) { task.pending.issue = "Submit: " + error.message; }
  if (submission?.clicked === false) {
    const reason = "Submit не нажат. " + (submission.reason || submitProblem[submission.step] || "Сверка формы не прошла.");
    await cancelBeforeSubmit(task, single, reason);
    throw new Manual(reason);
  }
  if (task.pending.issue) await save();
  const started = Date.now();
  let deadline = started + (quiz ? 18000 : 7500);
  let acknowledged;
  while (Date.now() < deadline) {
    checkpoint();
    await sleep(600);
    const resultView = await callCoursera(tab, "read", args).catch(() => null);
    if (resultView?.processing) {
      deadline = started + 60000;
      await stage(resultView.processing === "submitting" ? "Coursera отправляет работу" : "Coursera проверяет ответы");
      continue;
    }
    const result = resultView && confirmedResult(resultView, task.pending);
    if (!result) continue;
    if (quiz && result === "submitted" && !resultView.grade) {
      deadline = started + 60000;
      acknowledged = resultView;
      await stage("Жду оценку Coursera");
      continue;
    }
    if (single) single.history = newHistoryStatus(resultView.history, baseline);
    record(task, result, resultView);
    return;
  }
  if (acknowledged) record(task, "submitted", acknowledged);
  else await recover(course, task);
}

async function runSingle(single) {
  const course = state.courses[single.slug] ||= { slug: single.slug, url: "/learn/" + single.slug, title: single.slug, tasks: {} };
  state.current = { title: "Проверка одного задания", url: single.url };
  await save();
  try {
    const grades = await scanGrades(course);
    const row = grades.tasks.find(item => item.key === single.key);
    if (!row) throw new Manual("Ссылка не совпала с оцениваемым заданием в Grades.");
    const task = course.tasks[row.key] ||= { ...row, status: "queued" };
    task.gradeStatus = row.status;
    task.peer = row.peer;
    single.title = row.title;
    state.current.task = row.title;
    if (single.kind === "quiz" && task.peer) throw new Manual("Это задание с взаимной проверкой, выберите квиз.");
    if (row.status === "passed") {
      record(task, "passed", row);
    } else if (["submitted", "peer", "failed"].includes(row.status) && !task.pending) {
      record(task, row.status, row);
    } else if (!single.started || task.pending) {
      await processTask(course, task, single);
    }
    single.result = task.status;
    single.grade = task.grade;
    single.reason = task.reason || "";
    if (single.started && !single.history) {
      const { view } = await readTask(task, { history: true });
      const historyStatus = newHistoryStatus(view.history, single.baseline);
      if (historyStatus) {
        single.history = historyStatus;
        if (task.pending) record(task, historyStatus, view);
        single.result = task.status;
        single.grade = task.grade;
      } else {
        single.reason = [single.reason, view.historyIssue || "Новая запись в истории попыток не подтверждена."].filter(Boolean).join(" ");
      }
    } else if (!single.started && ["passed", "peer", "submitted", "failed"].includes(task.status)) {
      single.reason = [task.reason, "В Coursera уже есть результат."].filter(Boolean).join(" ");
    }
  } catch (error) {
    if (error instanceof Hold) throw error;
    single.reason = error.message;
    single.result = "manual";
  }
  checkpoint();
  state.mode = "done";
  state.current = null;
  await save();
}

async function coordinate(action, slug) {
  const { key, worker } = state.parallel;
  let response;
  try {
    response = await fetch(PARALLEL_ORIGIN + "/" + action, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ slug, worker }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(6000)
    });
  } catch {
    throw new Hold("Координатор недоступен. Запустите его или выключите «Использовать координатор» в настройках, затем нажмите «Продолжить».");
  }
  if (response.status === 403) throw new Hold("Код очереди отклонён. Запустите координатор для той же очереди.");
  if (!response.ok) throw new Hold("Координатор отклонил операцию «" + action + "» (HTTP " + response.status + ").");
  const { status } = await response.json();
  const expected = { check: ["ready"], claim: ["owned", "busy", "done", "own_done"], finish: ["done"] };
  if (!expected[action].includes(status)) throw new Hold("Координатор вернул неожиданный ответ.");
  return status;
}

async function finishParallelCourse() {
  await coordinate("finish", state.parallelCourse.slug);
  delete state.parallelCourse;
  await save();
}

async function run() {
  if (state.single) return runSingle(state.single);
  if (state.parallel) {
    await coordinate("check");
    if (state.parallelCourse?.done) await finishParallelCourse();
  }
  if (!state.discovery) await scanCourses();
  const order = state.parallelCourse
    ? [state.parallelCourse.slug, ...state.order.filter(slug => slug !== state.parallelCourse.slug)]
    : state.order;
  for (const slug of order) {
    checkpoint();
    const course = state.courses[slug];
    if (course.finished === state.wave || finishedCourse(course)) {
      if (state.parallel && state.parallelCourse?.slug === slug) await finishParallelCourse();
      continue;
    }
    if (state.parallel) {
      const ownership = await coordinate("claim", slug);
      if (ownership !== "owned") {
        if (state.parallelCourse?.slug === slug) throw new Hold("Координатор не подтвердил закрепление текущего курса.");
        if (ownership === "own_done") delete course.parallel;
        else course.parallel = { ownership, wave: state.wave };
        await save();
        continue;
      }
      delete course.parallel;
      state.parallelCourse = { slug };
    }
    state.current = { title: course.title, url: course.url };
    course.reason = "";
    await save();
    checkpoint();
    try {
      if (course.prepared !== state.wave) {
        reconcile(course, await scanGrades(course, !Object.values(course.tasks).some(task => task.pending)), true);
        course.prepared = state.wave;
        await save();
      }
      for (const id of course.taskOrder || []) {
        if (course.status === "certificate") break;
        const task = course.tasks[id];
        if (task.visited === state.wave) continue;
        state.current = { title: course.title, url: course.url, task: task.title };
        await save();
        try { await processTask(course, task); }
        catch (error) {
          if (error instanceof Hold) throw error;
          task.status = task.pending ? "uncertain" : "manual";
          task.reason = (task.pending ? "Результат отправки не установлен. " : "") + error.message;
        }
        task.visited = state.wave;
        await save();
      }
      if (course.status !== "certificate") reconcile(course, await scanGrades(course));
      if (course.status !== "certificate") await recheckCertificate(course);
      course.status = resultForCourse(course);
      course.reason = course.status === "awaitingCertificate" ? "Grades подтверждает зачёт. Выданный сертификат пока не найден." :
        course.status === "manual" && !Object.keys(course.tasks).length ? "Оцениваемые задания в Grades не распознаны." : "";
    } catch (error) {
      if (error instanceof Hold) throw error;
      course.status = "manual";
      course.reason = error.message;
    }
    course.finished = state.wave;
    if (state.parallelCourse?.slug === slug) state.parallelCourse.done = true;
    await save();
    if (state.parallel) await finishParallelCourse();
  }
  checkpoint();
  state.mode = "done";
  state.current = null;
  await save();
}
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}
function kick() {
  if (running || state.mode !== "running") return;
  running = run().catch(async error => {
    if (state.mode === "running") {
      state.mode = "paused";
      state.reason = error.message;
      await save();
    }
  }).finally(() => {
    running = null;
    if (state.mode !== "running") void chrome.alarms.clear(ALARM);
  });
}

chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
chrome.runtime.onStartup.addListener(() => {
  void load().then(async () => {
    if (state.mode === "running") {
      state.mode = "paused";
      state.reason = restartReason;
      await save();
    }
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void load().then(kick);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL("ui/index.html")) return false;
  (async () => {
    await load();
    if (message.action === "native") {
      await probeNative();
      return { ok: true };
    }
    if (message.action === "settings") {
      if (!Object.hasOwn(PROVIDERS, message.settings?.provider)) throw new Error("Неизвестный адаптер.");
      const chatRequests = message.settings.chatRequests ?? settings.chatRequests;
      if (!Number.isSafeInteger(chatRequests) || chatRequests < 0) throw new Error("Укажите целое число запросов от 0.");
      const quizDelaySeconds = message.settings.quizDelaySeconds ?? settings.quizDelaySeconds;
      if (!Number.isSafeInteger(quizDelaySeconds) || quizDelaySeconds < 0 || !Number.isSafeInteger(quizDelaySeconds * 1000)) {
        throw new Error("Укажите допустимое целое число секунд задержки от 0.");
      }
      const parallelKey = message.settings.parallelKey ?? settings.parallelKey;
      const parallelEnabled = message.settings.parallelEnabled ?? settings.parallelEnabled;
      if (typeof parallelEnabled !== "boolean") throw new Error("Выберите режим работы координатора.");
      if (parallelEnabled && !/^[a-f0-9]{32}$/.test(parallelKey)) throw new Error("Введите 32 символа кода координатора.");
      if (parallelEnabled !== settings.parallelEnabled && state.mode === "running") {
        throw new Error("Поставьте очередь на паузу перед сменой режима.");
      }
      if (parallelKey !== settings.parallelKey && (state.mode === "running" || state.parallelCourse)) {
        throw new Error("Завершите текущую очередь перед сменой кода.");
      }
      settings = { provider: message.settings.provider, fallback: !!message.settings.fallback, chatRequests, quizDelaySeconds, parallelEnabled, parallelKey,
        parallelWorker: settings.parallelWorker || (parallelEnabled ? crypto.randomUUID() : undefined) };
      await chrome.storage.local.set({ settings });
    }
    if (message.action === "pause" && state.mode === "running") {
      state.mode = "paused";
      state.reason = "Пауза по запросу.";
      await save();
    }
    if (["start", "resume", "single"].includes(message.action)) {
      if (running || state.mode === "running") throw new Error("Дождитесь завершения текущего шага и повторите.");
      if (message.action === "resume" && state.mode !== "paused") throw new Error("Очередь не на паузе.");
      if (message.action === "single") {
        if (settings.parallelEnabled) throw new Error("Для проверки одного квиза выключите использование координатора.");
        const url = new URL(message.url);
        const path = url.pathname.match(/^\/learn\/([a-z0-9-]+)\/(?:assignment-submission|quiz|assignment|peer|programming)\/[\w-]+(?:\/|$)/i);
        if (url.origin !== COURSERA || url.username || url.password || !path || Object.hasOwn(Object.prototype, path[1])) {
          throw new Error("Нужна прямая ссылка на задание Coursera.");
        }
        state.parallel = null;
        state.single = { url: url.origin + url.pathname, key: keyOf(url), slug: path[1], kind: "quiz" };
      }
      if (message.action === "start") {
        delete state.single;
      }
      if (message.action !== "single") {
        state.parallel = !state.single && settings.parallelEnabled ? { key: settings.parallelKey, worker: settings.parallelWorker } : null;
      }
      if (message.action !== "resume" || !state.wave) {
        state.wave++;
        state.discovery = false;
        state.notes = [];
      }
      state.mode = "running";
      state.reason = "";
      await chrome.storage.session.set({ runningWave: state.wave });
      await save();
      await ensureAlarm();
      kick();
    }
    return { ok: true };
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
