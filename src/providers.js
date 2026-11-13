(() => {
  if (globalThis.queueProvider) return;
  const configs = {
    chatgpt: {
      editor: '#prompt-textarea,[data-composer-body] [role=textbox][contenteditable=true],[data-chatgpt-composer] [data-composer-markdown][contenteditable=true]',
      send: '[data-testid=send-button],#composer-submit-button[aria-label*="Send" i],button[aria-label="Send message"],button[aria-label="Отправить сообщение"],[data-composer-body] button[aria-label="Send"],[data-composer-body] button[aria-label="Отправить"],[data-chatgpt-composer] button:is([aria-label="Send"],[aria-label="Отправить"])',
      stop: '[data-testid=stop-button],button[aria-label*="Stop generating" i],button[aria-label*="Остановить" i],button[aria-label="Stop"]',
      answers: '[data-message-author-role=assistant],[data-chatgpt-search-unit-key$=":assistant"]',
      users: '[data-message-author-role=user],[data-chatgpt-search-unit-key$=":user"]',
      done: '[data-testid=copy-turn-action-button],button[aria-label*="Copy" i],button[aria-label*="Копировать" i]',
      turn: '[data-talvt-turn-state],[data-testid^=conversation-turn-],article'
    },
    gemini: {
      editor: 'rich-textarea [contenteditable=true],.ql-editor[contenteditable=true]',
      send: 'button[aria-label*="Send message" i],button.send-button',
      stop: 'button[aria-label*="Stop response" i],button[aria-label*="Stop generating" i],button.stop-button',
      answers: 'model-response .model-response-text,model-response message-content',
      users: 'user-query',
      done: 'button[aria-label*="Copy" i],button[aria-label*="Копировать" i],copy-button',
      turn: 'model-response'
    }
  };
  const visible = node => !!node?.getClientRects().length && !node.closest('[hidden],[aria-hidden=true]');
  const shown = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const txt = node => (node?.innerText || node?.textContent || "").trim();
  const enabled = node => !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const limit = /you.ve reached (?:your |the )?(?:usage |message |rate )?limit|rate limit|too many requests|try again later|you.re out of|достигнут лимит|слишком много запросов|попробуйте позже/i;
  const conversationLimit = /maximum length for this (?:conversation|chat)|this (?:conversation|chat) is too long|(?:message|length) limit (?:for|in) this (?:conversation|chat)|(?:лимит сообщений|максимальн\p{L}* длин\p{L}*)[^.!?]{0,40}(?:чата|чате|беседы|беседе|диалога|диалоге)/iu;
  let request;

  function serviceIssue(text, provider) {
    const code = provider === "chatgpt" && conversationLimit.test(text) ? "conversationLimit" :
      limit.test(text) ? "serviceLimit" : null;
    return code && Object.assign(new Error("Ограничение сервиса: " + text.slice(0, 220)), { code });
  }

  function check(provider, config, needsEditor = true) {
    const signIn = shown(document, "button,a[href]").find(node =>
      /^(?:log in|sign in|войти)$/i.test(node.getAttribute("aria-label") || txt(node)));
    if (/\/(?:auth\/login|login|signin)(?:\/|$)/.test(location.pathname) ||
        signIn || shown(document, 'input[type=password],iframe[src*=captcha],button[data-testid=login-button],a[href*="accounts.google.com/ServiceLogin"]').length) {
      throw new Error("Требуется вход или проверка доступа.");
    }
    const alerts = shown(document, '[role=alert],[role=status],[data-testid*=rate-limit i],[data-testid*=message-limit i],[data-testid*=conversation-limit i],[data-testid*=context-limit i]');
    for (const alert of alerts) {
      if (alert.closest(config.editor + "," + config.users)) continue;
      if (alert.closest(config.answers) && !alert.matches('[role=alert],[data-testid*=limit i]')) continue;
      const issue = serviceIssue(txt(alert), provider);
      if (issue) throw issue;
    }
    if (!needsEditor) return;
    const editors = shown(document, config.editor);
    if (editors.length !== 1) throw new Error("Не удалось однозначно найти поле ввода. Проверьте вход и интерфейс сервиса.");
    return editors[0];
  }

  function assistantNodes(config) {
    return shown(document, config.answers).filter(node => !node.parentElement.closest(config.answers));
  }

  const fileControls = 'button[aria-label^="Remove file" i],button[aria-label^="Remove attachment" i],button[aria-label^="Удалить файл" i],button[aria-label^="Удалить вложение" i],[data-testid*="remove-attachment" i]';
  function composer(editor) {
    return editor.closest('[data-chatgpt-composer],[data-composer-body],form') || document;
  }

  async function uploadSources(root, files, config) {
    const inputs = [...root.querySelectorAll('input[type=file]:not([accept]),input[type=file][accept=""]')]
      .filter(node => enabled(node) && !node.parentElement.closest('[hidden],[aria-hidden=true]'));
    if (inputs.length !== 1 || (!inputs[0].multiple && files.length > 1)) {
      throw new Error("Не найдено однозначное поле прикрепления файлов в ChatGPT.");
    }
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.mime }));
    }
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    for (let step = 0; step < 80; step++) {
      const alert = shown(root, '[role=alert]').find(node => /upload|file|загруз|файл/i.test(txt(node)));
      if (alert) throw new Error("Прикрепление в ChatGPT: " + txt(alert).slice(0, 200));
      const names = new Set(shown(root, '[title],[aria-label],span,div').flatMap(node =>
        [node.getAttribute("title"), node.getAttribute("aria-label"), node.childElementCount ? "" : txt(node)]));
      const busy = shown(root, '[role=progressbar],[aria-busy=true],[data-testid*="uploading" i],[class*="animate-spin"]');
      if (!busy.length && files.every(file => names.has(file.name)) && shown(root, config.send).some(enabled)) return;
      await sleep(300);
    }
    throw new Error("ChatGPT не подтвердил прикрепление: " + files.map(file => file.name).join(", "));
  }

  function trustedUrl(value) {
    if (!value) return null;
    const url = new URL(value, location.href);
    if (url.username || url.password) return null;
    if (url.origin === location.origin && ["blob:", "http:", "https:"].includes(url.protocol)) return url.href;
    if (url.protocol === "https:" && /(?:^|\.)oaiusercontent\.com$/.test(url.hostname)) return url.href;
    return null;
  }

  function attachments(latest) {
    const nodes = shown(latest, 'a[download],a[href^="blob:"],a[href^="sandbox:"],a[href*="/estuary/content"],a[href*="oaiusercontent.com"],[data-testid*=file-download i],[data-testid*=attachment-download i],button[aria-label^="Download " i],button[aria-label^="Скачать " i]');
    return nodes.map((node, index) => {
      const name = [node.getAttribute("download"), txt(node), node.getAttribute("aria-label"),
        node.getAttribute("href")?.match(/^sandbox:\/mnt\/data\/([^/]+)$/)?.[1]]
        .filter(Boolean).map(value => value.replace(/^(?:download|скачать)\s+/i, "").trim())
        .find(value => /^[\p{L}\p{N}_][\p{L}\p{N}_ .()-]{0,118}\.[\p{L}\p{N}_]{1,10}$/u.test(value));
      if (!name) return null;
      return { node, name, url: trustedUrl(node.getAttribute("href")), id: "attachment-" + (index + 1) };
    }).filter(Boolean);
  }

  async function attachmentBytes(item, limit) {
    if (!item.url) return null;
    const response = await fetch(item.url, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(7000) });
    if (!response.ok || !response.body) return null;
    if (!item.name.toLowerCase().endsWith(".html") && /^text\/html\b/i.test(response.headers.get("content-type") || "")) return null;
    if (Number(response.headers.get("content-length")) > limit) throw new Error("Вложение превышает максимальный размер.");
    const reader = response.body.getReader();
    const bytes = new Uint8Array(limit);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        await reader.cancel();
        throw new Error("Вложение превышает максимальный размер.");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    let binary = "";
    for (let offset = 0; offset < size; offset += 16384) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(size, offset + 16384)));
    }
    return size ? btoa(binary) : null;
  }

  globalThis.queueProvider = async (provider, action, data) => {
    const config = configs[provider];
    if (action === "send" || action === "ready") {
      const editor = check(provider, config);
      const root = composer(editor);
      if (shown(document, config.stop).length) throw new Error("Во вкладке идёт другая генерация.");
      if (txt(editor) || editor.value || shown(root, fileControls).length ||
          [...root.querySelectorAll('input[type=file]')].some(input => input.files.length)) {
        throw new Error("Во вкладке есть неотправленный черновик или прикреплённые файлы.");
      }
      if (action === "ready") return true;
      const baseline = new Set(assistantNodes(config));
      const users = new Set(shown(document, config.users));
      editor.focus();
      if (!document.execCommand("insertText", false, data.prompt)) {
        editor.textContent = data.prompt;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: data.prompt }));
      }
      if (data.sources?.length) {
        if (provider !== "chatgpt" || !(editor.value || txt(editor)).includes(data.id)) {
          throw new Error("Ввод изменился до прикрепления файлов Coursera.");
        }
        await uploadSources(root, data.sources, config);
      }
      let send;
      for (let step = 0; step < 12 && !send; step++) {
        send = shown(root, config.send).find(enabled);
        if (!send) await sleep(125);
      }
      if (!send || !(editor.value || txt(editor)).includes(data.id)) throw new Error("Кнопка отправки недоступна или ввод изменился.");
      request = { id: data.id, baseline, users, last: "", stable: 0 };
      send.click();
      return true;
    }
    if (!request || request.id !== data.id) throw new Error("Вкладка изменилась во время запроса.");
    if (action === "poll") check(provider, config, false);
    const generating = shown(document, config.stop).length > 0;
    const users = shown(document, config.users).filter(node => !request.users.has(node));
    const user = users.at(-1);
    if (!user || !txt(user).includes(data.id)) {
      return action === "poll" ? { phase: generating ? "generating" : "waitingRequest" } : null;
    }
    const latest = assistantNodes(config).filter(node => !request.baseline.has(node) &&
      (user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
    if (!latest) return action === "poll" ? { phase: generating ? "generating" : "waitingAnswer" } : null;
    if (action === "attachment" || action === "download") {
      if (request.completed !== latest) throw new Error("Ответ модели изменился до получения вложения.");
      const original = request.files.find(item => item.id === data.attachment);
      const current = attachments(latest).find(item => item.id === data.attachment);
      if (!original || !current || current.node !== original.node || current.name !== original.name || current.url !== original.url) {
        throw new Error("Ссылка вложения изменилась.");
      }
      if (action === "download") {
        current.node.click();
        return true;
      }
      let base64;
      try { base64 = await attachmentBytes(current, data.limit); }
      catch (error) {
        if (/превышает максимальный размер/.test(error.message)) throw error;
      }
      return { base64: base64 || null, url: current.url };
    }
    const content = shown(latest, '[data-markdown-text-style]');
    const answer = content.length ? content.map(txt).join("\n") : latest.innerText || latest.textContent || "";
    const code = shown(latest, "pre code").map(node => node.textContent);
    const issue = !answer.includes(data.id) && serviceIssue(answer, provider);
    if (issue) throw issue;
    const files = attachments(latest);
    const turn = latest.closest(config.turn);
    const turnState = turn?.getAttribute("data-talvt-turn-state");
    const active = generating || /^(?:streaming|generating|in[-_]progress)$/i.test(turnState || "");
    const done = turnState ? turnState === "complete" : !!turn && shown(turn, config.done).length > 0;
    const metadata = files.map(({ id, name }) => ({ id, name }));
    const signature = JSON.stringify([answer, code, metadata]);
    const changed = signature !== request.last;
    request.stable = changed || active || !done ? 0 : request.stable + 1;
    request.last = signature;
    if (active || (!done && changed)) return { phase: "generating", progressed: changed };
    if (!done || (!answer.trim() && !files.length)) return { phase: "waitingFinish", progressed: changed };
    if (request.stable < 2) return { phase: "settling", progressed: changed };
    request.completed = latest;
    request.files = files;
    return { phase: "complete", reply: { text: answer, code, attachments: metadata } };
  };
})();
