import { COURSERA, NATIVE_HOST, PROVIDERS } from "./config.js";
import { Hold, Manual } from "./core.js";

const LIMIT = 4 * 1024 * 1024;
const baseName = path => path.split(/[\\/]/).at(-1);
const safeName = name => /^[\p{L}\p{N}_][\p{L}\p{N}_ .()-]{0,118}\.[\p{L}\p{N}_]{1,10}$/u.test(name) && !name.includes("..");
const workspace = "CourseraQueue";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browserClick;

function allowedUrl(value, provider) {
  try {
    const url = new URL(value);
    if (provider === "coursera") return !url.username && !url.password &&
      (url.origin === COURSERA || (url.protocol === "https:" &&
        (/(?:^|\.)coursera\.org$/.test(url.hostname) || url.hostname === "d3c33hcgiwev3.cloudfront.net")));
    return !url.username && !url.password &&
      ((["http:", "https:", "blob:"].includes(url.protocol) && url.origin === PROVIDERS[provider]) ||
       (url.protocol === "https:" && /(?:^|\.)oaiusercontent\.com$/.test(url.hostname)));
  } catch { return false; }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const target = browserClick;
  const match = target && Date.parse(item.startTime) >= target.started &&
    (target.url ? item.url === target.url && (!item.byExtensionId || item.byExtensionId === chrome.runtime.id) :
      baseName(item.filename) === target.name &&
      [item.url, item.finalUrl, item.referrer].some(url => allowedUrl(url, target.provider)));
  if (!match || (target.id !== null && target.id !== item.id)) {
    suggest();
    return;
  }
  target.id = item.id;
  suggest({ filename: target.relative, conflictAction: "uniquify" });
});

function native(request) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    let encoded = "";
    let finished = false;
    const timer = setTimeout(() => finish(new Error("Локальный помощник не ответил вовремя.")), 30000);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      port.disconnect();
      if (error) reject(error);
      else resolve(result);
    }
    port.onMessage.addListener(message => {
      if (message.error) return finish(new Error(message.error));
      if (typeof message.chunk === "string") {
        encoded += message.chunk;
        if (encoded.length > 4 * Math.ceil(LIMIT / 3)) finish(new Error("Помощник вернул слишком большой файл."));
      } else if (message.result && typeof message.result === "object") {
        finish(null, encoded ? { ...message.result, base64: encoded } : message.result);
      } else finish(new Error("Неизвестный ответ локального помощника."));
    });
    port.onDisconnect.addListener(() => finish(new Error(chrome.runtime.lastError?.message ||
      "Связь с локальным помощником прервана.")));
    try { port.postMessage(request); }
    catch (error) { finish(error); }
  });
}

export async function describeFiles(assessment) {
  for (const question of assessment.questions) {
    if (question.type !== "file") continue;
    try {
      const { spec } = await native({ action: "describe", question, instructions: assessment.fileInstructions ?? assessment.instructions });
      question.fileSpec = spec;
    } catch (error) {
      throw new Manual("Требования к файлу: " + error.message + " Проверьте установку помощника по README.");
    }
  }
}

export async function probeNative() {
  const { spec } = await native({ action: "describe", question: { accept: ".py" } });
  if (spec?.extensions.join() !== ".py") throw new Error("Помощник вернул неожиданный результат.");
}

async function download(file, url, provider, maxBytes, click, checkpoint) {
  const nonce = crypto.randomUUID();
  const relative = [workspace, nonce, file.name].join("/");
  const direct = url && !url.startsWith("blob:") ? url : null;
  if (direct && !allowedUrl(direct, provider)) throw new Error("Адрес загрузки вложения не принадлежит адаптеру.");
  const target = { id: null, name: file.name, relative, provider, url: direct, started: Date.now() };
  browserClick = target;
  try {
    let id;
    if (direct) {
      id = await chrome.downloads.download({ url: direct, filename: relative, conflictAction: "uniquify", saveAs: false });
      if (target.id !== null && target.id !== id) throw new Error("Chrome вернул другой ID загрузки.");
      target.id = id;
    } else {
      await click();
      for (let step = 0; step < 40 && target.id === null; step++) {
        checkpoint();
        await sleep(250);
      }
      if (target.id === null) throw new Error("Не получен ID браузерной загрузки текущего вложения.");
      id = target.id;
    }
    for (let step = 0; step < 80; step++) {
      checkpoint();
      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("Chrome не нашёл загрузку #" + id);
      if (item.state === "interrupted") throw new Error("Загрузка #" + id + " прервана: " + (item.error || "причина не указана"));
      if (Math.max(item.totalBytes, item.bytesReceived) > maxBytes) {
        if (item.state === "in_progress") await chrome.downloads.cancel(id).catch(() => {});
        throw new Error("Загрузка #" + id + " превышает допустимый размер.");
      }
      if (item.state === "complete") {
        const finalUrl = new URL(item.finalUrl || item.url);
        const courseraRedirect = provider === "coursera" && new URL(item.url).origin === COURSERA &&
          /^\/api\/rest\/v1\/asset\/download\//.test(new URL(item.url).pathname) &&
          finalUrl.protocol === "https:" && !finalUrl.username && !finalUrl.password;
        if ((!allowedUrl(finalUrl.href, provider) && !courseraRedirect) ||
            !item.filename.replaceAll("\\", "/").endsWith("/" + relative)) {
          throw new Error("Загрузка #" + id + " завершилась по другому адресу или вне папки CourseraQueue.");
        }
        return { path: item.filename, nonce };
      }
      await sleep(350);
    }
    throw new Error("Загрузка #" + id + " не завершилась. Проверьте её в chrome://downloads.");
  } finally {
    browserClick = null;
  }
}

async function sourceBytes(source, maximum) {
  let response;
  try {
    response = await fetch(source.url, { credentials: "include", signal: AbortSignal.timeout(8000) });
  } catch { return null; }
  if (!response.ok || !response.body || /^text\/html\b/i.test(response.headers.get("content-type") || "")) return null;
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Файл превышает допустимый размер.");
  const reader = response.body.getReader();
  let binary = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Файл превышает допустимый размер.");
      }
      for (let offset = 0; offset < value.length; offset += 16384) {
        binary += String.fromCharCode(...value.subarray(offset, offset + 16384));
      }
    }
  } finally { reader.releaseLock(); }
  return size ? { size, base64: btoa(binary), mime: response.headers.get("content-type")?.split(";")[0] } : null;
}

export async function courseFiles(sources, checkpoint) {
  if (sources.length > 8) throw new Manual("В задании больше восьми файлов. Приложите материалы вручную.");
  const files = [];
  let remaining = 12 * 1024 * 1024;
  for (const source of sources) {
    checkpoint();
    try {
      if (!safeName(source.name) || !allowedUrl(source.url, "coursera")) {
        throw new Error("Не поддерживается имя файла или адрес источника.");
      }
      if (files.some(file => file.name === source.name)) throw new Error("У разных материалов одинаковые имена.");
      const maximum = Math.min(LIMIT, remaining);
      if (!maximum) throw new Error("Исчерпан общий лимит 12 МиБ.");
      const data = await sourceBytes(source, maximum) || await native({ action: "course-source", name: source.name,
        ...await download(source, source.url, "coursera", maximum, null, checkpoint) });
      if (!data.size || data.size > maximum) throw new Error("Файл пуст или превышает допустимый размер.");
      const prefix = atob(data.base64.slice(0, 64));
      if (/^\s*<(?:!doctype html|html)\b/i.test(prefix) ||
          (/\.pdf$/i.test(source.name) && !prefix.startsWith("%PDF-"))) {
        throw new Error("Coursera вернула страницу или данные другого формата.");
      }
      remaining -= data.size;
      files.push({ name: source.name, base64: data.base64, mime: data.mime || "application/octet-stream" });
    } catch (error) {
      if (error instanceof Hold) throw error;
      throw new Manual("Материал Coursera «" + source.name + "»: " + error.message);
    }
  }
  return files;
}

export async function prepareFiles(answers, assessment, provider, attachment, checkpoint) {
  const used = new Set();
  for (const answer of answers) {
    const file = answer.file;
    if (!file) continue;
    checkpoint();
    const question = assessment.questions.find(item => item.id === answer.id);
    const spec = question.fileSpec;
    if (!safeName(file.name) || (spec.exactName && file.name !== spec.exactName) ||
        !spec.extensions.some(ext => file.name.toLowerCase().endsWith(ext))) {
      throw new Error("Ожидалось имя " + (spec.exactName || spec.extensions.join(" или ")) + ", получено " + file.name.slice(0, 120));
    }
    const context = { question, instructions: assessment.fileInstructions ?? assessment.instructions };
    if (!file.attachment) {
      answer.file = await native({ action: "build", ...context, file });
      continue;
    }
    if (used.has(file.attachment)) throw new Error("Одно вложение указано для нескольких файловых полей.");
    used.add(file.attachment);
    const source = await attachment("attachment", file.attachment, spec.maxBytes);
    if (!source) throw new Error("Вложение больше не связано с текущим ответом.");
    const bytes = source.base64 ? { base64: source.base64 } :
      await download(file, source.url, provider, spec.maxBytes, () => attachment("download", file.attachment), checkpoint);
    answer.file = await native({ action: "attachment", ...context, name: file.name, ...bytes });
  }
}
