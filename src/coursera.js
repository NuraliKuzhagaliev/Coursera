(() => {
  if (globalThis.queueCoursera) return;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const select = (root, selector) => [...root.querySelectorAll(selector)];
  const clean = value => (value || "").replace(/\s+/g, " ").trim();
  const label = element => clean(element?.getAttribute("aria-label") || element?.innerText || element?.textContent);
  const visible = element => !!element?.getClientRects().length && !element.closest("[hidden],[aria-hidden=true]");
  const main = () => document.querySelector("main,[role=main]") || document.body;
  const shown = (root, selector) => select(root, selector).filter(visible);
  const enabled = node => node && !node.disabled && !node.closest("[aria-disabled=true]");
  const controls = (root, regex) => shown(root, "a[href],button,[role=button],[role=tab],input[type=submit]")
    .filter(node => regex.test(label(node) || node.value || ""));
  const localLink = link => {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return null;
    return url.pathname + url.search;
  };
  const courseSlug = path => path?.match(/^\/learn\/([^/?#]+)(?:[/?]|$)/)?.[1];
  const taskPath = /^\/learn\/[^/]+\/(?:assignment-submission|quiz|assignment|programming|peer|exam|lab|supplement|lecture|discussionPrompt|item)\/[\w-]+(?:\/|$)/i;
  const title = () => label(main().querySelector("h1"));
  const auth = () => {
    if (/^\/(?:login|signup)(?:\/|$)/i.test(location.pathname) ||
        shown(document, 'input[type=password],iframe[src*="captcha"]').length) {
      throw new Error("Coursera: требуется вход или проверка доступа.");
    }
  };
  const certificatePath = /^\/account\/accomplishments\/(?:verify|certificate)\/[A-Za-z0-9]+(?:\/|\?|$)/;
  const certificateLink = root => shown(root, "a[href]").find(node => certificatePath.test(localLink(node) || ""));
  const statusOf = value => {
    const text = clean(value).toLowerCase().replace(/^(?:success|error|warning|info):\s*/, "");
    if (/^(?:not passed|(?:you )?did(?:n['’]t| not) pass|failed|не зачтено|не сдано)(?:$|[ .:!–—])/i.test(text)) return "failed";
    if (/^(?:(?:you )?passed|зачтено|сдано)(?:$|[ .:!–—])/i.test(text)) return "passed";
    if (/^(?:awaiting peer (?:reviews?|grading)|pending peer (?:reviews?|grading)|waiting for peer reviews?|ожидает (?:взаимопроверки|проверки (?:одногруппниками|участниками)))(?:$|[ .:!–—])/i.test(text)) return "peer";
    if (/^(?:submitted|submission received|successfully submitted|your (?:assignment|work|submission) (?:was |has been )?(?:submitted|received)|awaiting (?:automatic |ai )?grading|grading in progress|pending (?:grade|grading)|отправлено|работа отправлена|идёт автоматическая проверка)(?:$|[ .:!–—])/i.test(text)) return "submitted";
    if (/^(?:locked|unavailable|заблокировано|недоступно)(?:$|[ .:!–—])/i.test(text)) return "locked";
    if (/^(?:--|not submitted|not started|in progress|не отправлено|не начато|в процессе)(?:$|[ .:!–—])/i.test(text)) return "open";
    return null;
  };
  const gradeOf = node => label(node).match(/^\d+(?:[.,]\d+)?\s*%$/)?.[0] || null;
  const peerManual = root => controls(root, /^(?:review (?:your )?peers?|review (?:a|another|peer) submission|write (?:a )?peer reviews?|review classmates|оценить работы|проверить работы)(?:$|[ (])/i).some(enabled);
  const card = node => node.closest("article,li,[data-testid*=card i],[data-testid*=accomplishment i]");
  const plusStatus = /^(?:status|статус):\s*plus$/i;
  const hasPlus = () => shown(document, "button[aria-label]").some(button =>
    /user dropdown menu|меню пользователя/i.test(button.getAttribute("aria-label")) &&
    [button, ...select(button, '[data-testid="visually-hidden"],[data-testid="tag-root"],[aria-label]')]
      .some(node => plusStatus.test(clean(node.textContent)) || plusStatus.test(clean(node.getAttribute("aria-label")))));

  function enrollment(slug) {
    const course = "/learn/" + slug;
    if (location.pathname.replace(/\/$/, "") !== course) return {};
    const buttons = shown(document, 'button[data-e2e="enroll-button"]').filter(enabled);
    const included = buttons.filter(button => {
      const action = button.getAttribute("formaction") ?? button.form?.getAttribute("action");
      const target = button.getAttribute("formtarget") ?? button.form?.getAttribute("target");
      if (!action || !URL.canParse(action, location.href) || (target && target.toLowerCase() !== "_self")) return false;
      const url = new URL(action, location.href);
      return url.origin === location.origin && !url.username && !url.password && url.pathname.replace(/\/$/, "") === course &&
        /^enroll\s*included with coursera plus$/i.test(clean(button.innerText || button.textContent));
    });
    if (included.length === 1) return { included: included[0] };
    return { manual: buttons.length > 0 || controls(main(), /^(?:enroll(?: for free)?|записаться)(?:$|\s)/i).some(enabled) };
  }

  function catalogItems(mode) {
    const result = [];
    const panel = shown(main(), "[role=tabpanel]")[0] || main();
    for (const link of shown(panel, "a[href]")) {
      const path = localLink(link);
      const slug = courseSlug(path);
      if (mode === "courses" && slug && !taskPath.test(path)) {
        const box = card(link);
        const name = label(link) || label(box?.querySelector("h2,h3,h4,[data-testid*=title i]"));
        if (name && !/^(?:go to course|resume|continue|start|перейти|продолжить)(?:$|\s)/i.test(name)) {
          const sole = box && new Set(shown(box, "a[href]").map(item => courseSlug(localLink(item))).filter(Boolean)).size === 1;
          const issued = sole && (certificateLink(box) || controls(box, /^(?:view certificate|посмотреть сертификат)$/i).find(enabled));
          result.push({ slug, title: name, url: "/learn/" + slug, certificate: !!issued });
        }
      }
      if (mode === "certificates" && certificatePath.test(path || "")) {
        const box = card(link);
        if (!box) continue;
        const associated = [...new Set(shown(box, "a[href]").map(item => courseSlug(localLink(item))).filter(Boolean))];
        const type = label(box.querySelector("[data-testid*=type i]")) || label(box);
        const preview = box.querySelector("img[alt]")?.getAttribute("alt")?.match(/^(.+) certificate preview image$/i)?.[1];
        const courseTitle = label(box.querySelector("h2,h3,h4,[data-testid*=title i]")) || preview;
        if (associated.length === 1) result.push({ slug: associated[0] });
        else if (courseTitle && (preview || /course certificate|сертификат курса/i.test(type))) result.push({ title: courseTitle });
      }
    }
    return result;
  }
  const nextPage = /^(?:(?:go to )?next(?: page)?|следующая(?: страница)?|далее)$/i;
  const emptyCatalog = /no (?:(?:completed|active) )?(?:courses|enrollments|certificates)|haven.t (?:enrolled|earned|completed|started)|нет (?:курсов|сертификатов)/i;
  const catalogTabs = root => controls(root, /^(?:all(?: courses)?|in progress|completed|archived|inactive|certificates|все(?: курсы)?|в процессе|заверш[её]нные|архив|неактивные|сертификаты)(?:\s*\(\d+\))?$/i)
    .filter(node => !node.closest("article,li[data-testid*=card i]") &&
      (node.getAttribute("role") === "tab" || node.closest("nav") || node.matches("a[href]")));
  const catalogTabKey = node => node?.id.match(/-tab-(IN_PROGRESS|COMPLETED|CERTIFICATES)$/)?.[1];

  function catalogView(mode) {
    const root = main();
    if (!root || !/^\/(?:my-learning|account\/accomplishments)(?:\/|$)/.test(location.pathname)) {
      return { ready: false, tabs: [] };
    }
    const panel = shown(root, "[role=tabpanel]")[0] || root;
    const tabs = catalogTabs(root);
    const selected = tabs.find(node => node.getAttribute("aria-selected") === "true");
    const panelTab = panel.getAttribute("aria-labelledby");
    const matchingPanel = !selected?.id || !panelTab || panelTab.split(/\s+/).includes(selected.id);
    const items = catalogItems(mode);
    const empty = emptyCatalog.test(label(panel));
    const currentNumber = shown(panel, '[data-testid="pagination-controls"] button[aria-label^="Page number " i]')
      .map(node => node.getAttribute("aria-label").match(/^page number (\d+)/i)?.[1]).find(Boolean);
    const requestedPage = new URLSearchParams(location.search).get("page");
    const page = currentNumber || clean(shown(root, "[aria-current=page]").map(label).join(" "));
    const selectedLabel = label(selected);
    return {
      ready: matchingPanel && panel.getAttribute("aria-busy") !== "true" &&
        (!currentNumber || !requestedPage || currentNumber === requestedPage) &&
        (items.length > 0 || empty || (mode === "certificates" && shown(panel, '[data-testid="certificate-card"]').length > 0)),
      tabs: tabs.map(node => {
        const key = /^\/my-learning\/?$/.test(location.pathname) ? catalogTabKey(node) : null;
        const href = node.matches("a[href]") ? localLink(node) : key ? "/my-learning?myLearningTab=" + key : null;
        return { label: label(node), href, key, selected: node === selected };
      }),
      selected: selectedLabel, selectedKey: catalogTabKey(selected), empty, page,
      snapshot: JSON.stringify([location.pathname, location.search, selectedLabel, page,
        items.map(item => item.slug || item.title)])
    };
  }

  async function catalog(mode) {
    const items = new Map();
    let idle = 0;
    for (let step = 0; step < 36 && idle < 3; step++) {
      auth();
      const size = items.size;
      for (const item of catalogItems(mode)) {
        const key = item.slug || item.title;
        if (!items.has(key) || item.certificate) items.set(key, item);
      }
      const more = controls(main(), /^(?:show more(?: courses)?|load more(?: courses)?|показать (?:ещё|еще)|загрузить (?:ещё|еще))$/i).find(enabled);
      if (more) more.click();
      const last = shown(main(), "article,li,a[href*='/learn/'],a[href*='/accomplishments/']").at(-1);
      last?.scrollIntoView({ block: "end" });
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(400);
      idle = !more && size === items.size ? idle + 1 : 0;
    }
    const view = catalogView(mode);
    const next = controls(main(), nextPage)
      .filter(node => node.getAttribute("rel") === "next" || node.closest('nav,[role=navigation],[data-testid*=pagin i]'))
      .find(enabled);
    let nextPageTarget = next ? (next.matches("a[href]") ? localLink(next) : true) : null;
    if (nextPageTarget === true && next.closest('[data-testid="pagination-controls"]') &&
        /^\/my-learning\/?$/.test(location.pathname) && view.selectedKey === "IN_PROGRESS" && /^\d+$/.test(view.page)) {
      const url = new URL(location.href);
      url.searchParams.set("myLearningTab", "IN_PROGRESS");
      url.searchParams.set("page", String(Number(view.page) + 1));
      nextPageTarget = url.pathname + url.search;
    }
    return {
      ...view, items: [...items.values()], truncated: idle < 3,
      next: nextPageTarget
    };
  }

  function grades() {
    const root = main();
    const rows = shown(root, "tr,[role=row],[data-testid*=grade-row i],[data-testid$=assignment-row]");
    const headers = shown(root, "th,[role=columnheader]").map(label);
    const statusIndex = headers.findIndex(value => /^(?:status|статус)$/i.test(value));
    const tasks = [], reviews = [];
    for (const row of rows) {
      const cells = shown(row, "td,[role=cell],[role=gridcell],[role=rowheader]");
      const link = shown(row, "a[href]").find(node => taskPath.test(localLink(node) || ""));
      const type = label(row.querySelector("[data-testid*=type i]")) || cells.map(label).join(" ");
      const review = cells.map(label).find(value => /^Review \d+ peers?['’] assignments?\.?$/i.test(value));
      if (review) {
        if (!cells.some(cell => statusOf(label(cell)) === "passed" || /^(?:complete|completed|done)$/i.test(label(cell)))) {
          reviews.push({ title: review, url: location.pathname });
        }
        continue;
      }
      if (!link || /practice (?:quiz|assignment)|ungraded|optional|тренировоч|неоцениваем/i.test(type)) continue;
      const path = localLink(link);
      if (courseSlug(path) !== courseSlug(location.pathname)) continue;
      const key = path.split("?")[0].split("/").slice(0, 5).join("/");
      const status = statusIndex < 0 ? cells.map(cell => statusOf(label(cell))).find(Boolean) : statusOf(label(cells[statusIndex]));
      const grade = gradeOf(row.querySelector('[data-testid="assignment-item-grade"],[data-testid="grade"]'));
      tasks.push({ key, url: path, title: label(link) || key, status: status || "unknown", grade,
        peer: /\/peer\//i.test(path) || /peer.graded|взаимопровер/i.test(type), peerManual: peerManual(row) });
    }
    const cert = controls(root, /^(?:view(?: your)?(?: course)? certificate|посмотреть сертификат|сертификат курса)$/i)
      .some(node => node.matches("a[href]") && certificatePath.test(localLink(node) || ""));
    const next = controls(root, nextPage)
      .find(node => enabled(node) && node.closest("nav,[role=navigation],[data-testid*=pagin i]"));
    const gradesLink = controls(document, /^(?:grades|оценки|успеваемость)$/i).find(node => node.matches("a[href]"));
    const hasRows = rows.some(row => row.matches("[data-testid$=assignment-row],[data-testid*=grade-row i]") ||
      (headers.some(value => /^(?:status|grade|статус|оценка)$/i.test(value)) && row.querySelector("td,[role=cell],[role=gridcell]")));
    const empty = /^(?:no (?:graded )?assignments(?: yet)?|нет оцениваемых заданий)[.!]?$/i;
    const access = enrollment(courseSlug(location.pathname));
    return { tasks, reviews, cert, ready: tasks.length > 0 || hasRows || cert || shown(root, "p,[role=status],h2,h3").some(node => empty.test(label(node))),
      path: location.pathname, enroll: access.included ? "plus" : access.manual ? "manual" : null,
      activePlus: !!access.included && hasPlus(),
      dialog: shown(document, '[role=dialog],[role=alertdialog],dialog[open]').length > 0,
      gradesLink: gradesLink && localLink(gradesLink), next: next ? (next.matches("a[href]") ? localLink(next) : true) : null };
  }

  function status(root = quizPane() || main()) {
    const historySelector = "[data-testid*=attempt-history i],[aria-label*='attempt history' i],[data-testid*=submission-history i]";
    const history = shown(root, historySelector);
    const historyRows = history.flatMap(box => shown(box, "tbody tr,[role=row],[data-testid*=attempt-row i]"))
      .filter(row => !row.querySelector("th,[role=columnheader]"));
    const current = shown(root, "[data-testid*=submission-status i],[data-testid*=grade-status i],[data-testid*=attempt-status i], [role=status], [role=alert]")
      .filter(node => !node.closest(historySelector));
    const banners = shown(root, "p").filter(node => !node.closest(historySelector) &&
      /^(?:You passed!|You (?:did not|didn['’]t) pass\.?|Your (?:work|submission|assignment) (?:was |has been )?submitted[.!]?)$/i.test(label(node)));
    const states = [...current, ...banners].map(node => statusOf(label(node)));
    const explicit = ["passed", "failed", "peer", "submitted"].find(value => states.includes(value));
    const resultBanner = shown(root, '[data-testid="result-banner"]')[0];
    const feedbackBanner = shown(root, '[data-testid="AssignmentViewTopBanner"]')[0];
    const resultText = label(feedbackBanner);
    const gradeText = resultText.match(/\bYour grade:\s*(\d+(?:[.,]\d+)?)\s*%/i)?.[1];
    const latestGrade = resultText.match(/\bYour latest:\s*(\d+(?:[.,]\d+)?)\s*%/i)?.[1];
    const threshold = resultText.match(/\bTo pass you need (?:a grade of )?at least\s*(\d+(?:[.,]\d+)?)\s*%/i)?.[1];
    const quizResult = gradeText && threshold ?
      (Number(gradeText.replace(",", ".")) >= Number(threshold.replace(",", ".")) ? "passed" : "failed") : null;
    const grade = (latestGrade || gradeText) ? (latestGrade || gradeText) + "%" :
      gradeOf(resultBanner?.querySelector('[data-testid="grade"]')) ||
      gradeOf(root.querySelector('[data-testid="submission-grade"]'));
    const submitting = /\bsubmitting(?:\.{3}|…|\s|$)/i.test(label(assignmentDialog("submit")));
    const reviewing = shown(root, "h1,h2,h3,p,[role=status],[role=alert]").some(node =>
      /^reviewing your submission(?:\.{3}|…)?(?:\s+Hang tight\b|$)/i.test(label(node)));
    const summary = label(root);
    const latest = historyRows.find(row => row.matches("[aria-current=true],[data-latest=true]")) || historyRows[0];
    const countMatch = summary.match(/(?:attempts (?:made|used)|использовано попыток)\s*[: ]\s*(\d+)/i);
    const count = countMatch ? Number(countMatch[1]) : historyRows.length || null;
    const timestamp = latest?.querySelector("time")?.getAttribute("datetime");
    const attempt = latest && (latest.getAttribute("data-attempt-id") || timestamp || label(latest));
    const remaining = summary.match(/(\d+)\s+attempts?\s+(?:remaining|left)|(?:attempts remaining|оставшиеся попытки)\s*[: ]\s*(\d+)/i);
    const cooldown = summary.match(/(?:try again in|next attempt (?:available )?in|wait|повторите через)\s+\d+[^.]{0,65}|(?:next attempt (?:is )?available (?:at|on)|повтор доступен после)\s+[^.]{1,65}/i)?.[0];
    const feedback = shown(root, "[data-testid*=feedback i],[aria-label*=feedback i],[data-testid*=rubric-result i]")
      .filter(node => !node.matches("button,a")).map(label).join("\n").slice(0, 10000);
    return {
      status: quizResult || explicit || (latest && statusOf(label(latest.querySelector("[data-testid*=status i]")))) || null,
      processing: submitting ? "submitting" : reviewing ? "reviewing" : null,
      count, attempt: attempt || null, grade, remaining: remaining ? Number(remaining[1] || remaining[2]) :
        (/unlimited attempts|неограниченное число попыток/i.test(summary) ? -1 :
          /no attempts (?:remaining|left)|попытки закончились/i.test(summary) ? 0 : null),
      cooldown: cooldown || null, feedback, peerManual: peerManual(root),
      history: latest ? { attempt: attempt || null, status: statusOf(label(latest.querySelector("[data-testid*=status i]"))), count } : null
    };
  }
  const inputSelector = "input:not([type]),input[type=text],input[type=number],input[type=radio],input[type=checkbox],input[type=file],textarea,[contenteditable=true]";
  const checkbox = 'input[type=checkbox],[role=checkbox]';
  const dialogSelector = '[role=dialog],[role=alertdialog],dialog[open]';
  const quizPaneSelector = '[data-testid="assignment-view-tunnel-vision"] [data-testid="tunnel-vision-content"]';
  const quizPart = '[data-testid^="part-Submission_"]';
  const questionSection = "fieldset,[data-testid=question],[data-testid=quiz-question],[data-testid=assignment-question]," +
    "[data-testid*=question-container i],[data-testid*=question-card i],[data-testid*=submission-part i]";
  const visualContent = 'img,canvas,svg[role=img],svg[aria-label],figure svg,[data-testid="cml-viewer"] svg';
  const quizPane = () => {
    const panes = shown(document, quizPaneSelector);
    if (panes.length === 1) return panes[0];
    const dialogs = shown(document, '[role=dialog][aria-modal=true] [data-testid="tunnel-vision-content"]');
    if (dialogs.length === 1) return dialogs[0];
    const candidates = new Set(shown(document, 'button[data-testid="submit-button"]')
      .map(button => button.closest('[data-testid="tunnel-vision-content"],[role=dialog][aria-modal=true]'))
      .filter(root => root && shown(root, quizPart).length));
    return candidates.size === 1 ? [...candidates][0] : null;
  };
  const inOtherDialog = (node, quizDialog) => {
    const dialog = node.closest(dialogSelector);
    return !!dialog && dialog !== quizDialog;
  };
  const quizTitle = (root, quizDialog) => {
    const header = document.getElementById(quizDialog?.getAttribute("aria-labelledby") || "");
    return label(root.querySelector("h1") || header?.querySelector("h1,[role=heading]")) ||
      label(header).replace(/\s+Graded Assignment\s*[•·]\s*\d+\s*(?:min(?:utes?)?|h(?:ours?)?)(?:\s+\d+\s*min)?$/i, "") ||
      title();
  };
  const instructionText = node => {
    if (node.closest('nav,header,footer,aside,[data-testid="HonorCodeAgreement"]')) return "";
    const text = label(node);
    return /^(?:last saved|черновик сохран[её]н|последнее сохранение)(?:\s|[.:]|$)/i.test(text) ? "" : text;
  };
  const dialogLabels = {
    start: /(?:start|begin)\s+(?:your |this |the |(?:a )?new )?(?:assignment|quiz|attempt)|confirm (?:the )?start|(?:ready|want) to (?:start|begin)\?|начать (?:задание|квиз|тест|попытку)/i,
    submit: /submit\s+(?:your |this |the )?(?:assignment|quiz|answers|work)|confirm (?:your )?submission|(?:ready|want) to submit\?|отправить (?:задание|работу|ответы)|подтверждени[ея] отправки/i
  };
  const dialogButtons = {
    start: /^(?:start|begin|continue|confirm(?: start)?|(?:start|begin) (?:assignment|quiz|attempt)|yes,? (?:start|continue)|начать(?: (?:задание|квиз|тест|попытку))?|подтвердить|продолжить)$/i,
    submit: /^(?:submit(?: (?:assignment|quiz|answers|work|for review))?|confirm(?: submission)?|yes,? submit|отправить(?: (?:задание|работу|ответы))?|подтвердить(?: отправку)?)$/i
  };
  const timedAssignment = /(?:time limit|timed assignment|countdown|ограничение времени|\d+\s*(?:min|minutes|hours?)\s+per attempt)/i;

  function assignmentDialog(kind) {
    const pane = quizPane();
    return shown(document, dialogSelector).find(node =>
      !node.contains(pane) && dialogLabels[kind].test([label(node), label(node.querySelector("h1,h2,h3,[role=heading]"))].join(" ")));
  }

  function confirmDialog(kind, allowTimed = false) {
    const dialog = assignmentDialog(kind);
    if (!dialog) return false;
    if (kind === "start" && !allowTimed && timedAssignment.test(label(dialog))) throw new Error("Задание с таймером.");
    const checks = confirmations(dialog);
    if (!confirmChecks(checks) || !checks.every(checked)) return false;
    const buttons = controls(dialog, dialogButtons[kind]).filter(enabled);
    if (buttons.length !== 1) return false;
    buttons[0].click();
    return true;
  }
  const attestation = /honou?r code|my own work|work that (?:isn['’]t|is not) my own|academic integrity|I (?:agree|acknowledge|confirm|certify|understand)|кодекс чести|самостоятельно выполнил|подтверждаю|я соглас[еен]/i;
  const fieldName = node => label(node.labels?.[0] || node.closest("label")) ||
    clean(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby")?.split(/\s+/)
      .map(id => label(document.getElementById(id))).join(" ") || node.getAttribute("placeholder"));
  const displayed = node => visible(node) || [...(node.labels || [])].some(visible);
  const questionBox = node => node.closest(quizPart) || node.closest(questionSection + ",[role=group],[role=radiogroup]") ||
    node.closest("label") || node.parentElement;

  function visualTask(root, pane, form, boxes, quizDialog) {
    const sections = new Set([...shown(root, quizPart + "," + questionSection), ...boxes.keys()]);
    if (pane || form) sections.add(pane || form);
    for (const section of sections) {
      if (shown(section, visualContent).some(node => !inOtherDialog(node, quizDialog) &&
          !node.closest('nav,header,aside,footer,[data-testid="HonorCodeAgreement"],mjx-container,.katex') &&
          !node.matches('[role=presentation],[role=none]'))) return true;
    }
    return false;
  }
  const checked = node => node.matches("input") ? node.checked : node.getAttribute("aria-checked") === "true";
  function confirmations(root) {
    return select(root, checkbox).filter(node => displayed(node) &&
      !node.closest(quizPart + ",fieldset[data-testid*=question i],[data-testid*=quiz-question i],[data-testid=question],[data-testid*=question-container i],[role=radiogroup]") &&
      !(node.closest("fieldset")?.querySelectorAll(checkbox).length > 1) &&
      (attestation.test(fieldName(node) || label(node)) || node.closest("[data-testid*=honor i],[data-testid*=attestation i]") ||
        (!node.closest("fieldset") && (node.required || node.getAttribute("aria-required") === "true"))));
  }

  function confirmChecks(nodes) {
    for (const node of nodes) {
      if (checked(node)) continue;
      if (!enabled(node)) return false;
      const target = visible(node) ? node : [...(node.labels || [])].find(visible);
      if (!target) return false;
      target.click();
    }
    return true;
  }
  const assignmentKey = () => location.pathname.split("/").slice(0, 5).join("/");
  let submittedNonce;

  const peerInstructions = '[data-testid="peer-assignment-instructions"]';
  const materialCard = '[data-testid="asset-v2-wrapper"]';
  const fileLabel = /^[\p{L}\p{N}_][\p{L}\p{N}_ .()-]{0,118}\.[\p{L}\p{N}_]{1,10}$/u;
  const filePath = /\.(?:pdf|zip|7z|rar|gz|tar|docx?|xlsx?|pptx?|csv|txt|json|ipynb|py|csc)$/i;
  const materialDownload = /(?:^|[\n.!?]\s+)(?:please\s+)?(?:download|скачайте|скачать|загрузите)\s+[^\n.!?]{0,80}(?:\b(?:files?|dataset|archive|spreadsheet|notebook|pdf|zip)\b|файл|архив|набор данных)/i;
  const fileSubmission = /(?:^|[\n.!?]\s+)(?:please\s+)?(?:attach|upload|submit|прикрепите|отправьте)\s+[^\n.!?]{0,80}(?:\b(?:files?|archive|spreadsheet|notebook|pdf|zip)\b|файл|архив)/i;

  function downloadReason(scope) {
    for (const link of shown(scope, "a[href]")) {
      if (link.closest('nav,header,footer,aside,video,audio,[data-testid*="transcript" i],[data-testid*="player" i]')) continue;
      if (typeof link.href !== "string" || !URL.canParse(link.href)) continue;
      const url = new URL(link.href);
      const asset = link.closest(materialCard) || /\/api\/rest\/v1\/asset\/download\//.test(url.pathname);
      const name = [link.getAttribute("download"), ...link.innerText.split(/\r?\n/).map(clean)]
        .find(value => value && fileLabel.test(value));
      if (!link.hasAttribute("download") && !filePath.test(url.pathname) &&
          (!asset || (!name && /(?:video|audio|caption|transcript)/i.test(label(link) + " " + url.pathname)))) continue;
      return name ? "В инструкциях есть скачиваемый материал «" + name + "»." : "В задании есть скачиваемый материал.";
    }
    const download = controls(scope, /^(?:download|скачать)(?:\s|$)/i).find(node =>
      !node.closest('nav,header,footer,aside,[data-testid*="transcript" i],[data-testid*="player" i]') &&
      (node.closest(materialCard) || materialDownload.test(label(node))));
    if (download) return "В задании есть кнопка скачивания материала.";
    return null;
  }

  function instructionFileReason(instructions) {
    if (materialDownload.test(instructions)) return "Инструкции требуют скачать файл или набор данных.";
    if (fileSubmission.test(instructions)) return "Инструкции требуют прикрепить файл.";
    return null;
  }

  function materials(peer) {
    const pane = quizPane();
    const root = pane || main();
    const tab = peer && controls(root, /^(?:instructions|инструкции)$/i).find(node => node.matches('[role=tab]'));
    if (tab && tab.getAttribute("aria-selected") !== "true") {
      tab.click();
      return null;
    }
    const scope = tab ? shown(root, peerInstructions)[0] : root;
    if (!scope) return null;
    const collapsed = tab && shown(scope, '[data-testid="instructions-title"] button[aria-expanded=false]');
    if (collapsed?.length) {
      collapsed.forEach(node => node.click());
      return null;
    }
    const copy = scope.cloneNode(true);
    select(copy, materialCard + ',video,audio,[role=slider],[role=timer],[role=toolbar],[data-testid*="video-player" i],[data-testid*="transcript" i],button,svg')
      .forEach(node => node.remove());
    const instructions = tab ? select(copy, '[data-testid="cml-viewer"],[data-testid="instructions-title"]')
      .filter(node => !node.parentElement.closest('[data-testid="cml-viewer"]')).map(label).filter(Boolean).join("\n") : "";
    return { fileReason: downloadReason(scope) || instructionFileReason(instructions),
      instructions, switched: !!tab, title: quizTitle(root, pane?.closest(dialogSelector)) };
  }

  function inspect(peer, allowTimed = false) {
    const pane = quizPane();
    const root = pane || main();
    const quizDialog = pane?.closest(dialogSelector);
    const summary = label(root);
    const view = status(root);
    const open = controls(root, /^(?:start assignment|start quiz|start attempt|resume assignment|resume quiz|continue attempt|open assignment|start submission|go to my submission|my submission|начать задание|начать тест|моя работа|продолжить (?:попытку|задание))$/i)
      .filter(node => enabled(node) && !node.closest(dialogSelector));
    const retry = controls(root, /^(?:try again|retake|retry|start new attempt|повторить|новая попытка)$/i).filter(enabled);
    const feedback = controls(root, /^(?:view feedback|view results|посмотреть отзывы|посмотреть результаты)$/i).filter(enabled);
    const history = controls(root, /^(?:(?:view )?(?:attempt|submission) history|view (?:all )?attempts|история (?:попыток|отправок))$/i).filter(enabled);
    const submit = submitButtons(root, quizDialog);
    const form = submit.length === 1 ? submit[0].form || submit[0].closest("form,[role=form]") : null;
    const formRoot = form || submit[0]?.closest('[role=tabpanel]') || root;
    const checks = confirmations(formRoot).filter(node => !inOtherDialog(node, quizDialog));
    const fields = select(formRoot, inputSelector + ',.rc-FileUploadEditView')
      .filter(node => displayed(node) && !checks.includes(node) && !inOtherDialog(node, quizDialog) &&
        !node.closest("nav,header," + peerInstructions) &&
        (!node.closest(".rc-FileUploadEditView") || node.matches(".rc-FileUploadEditView")));
    const reason = !allowTimed && timedAssignment.test(summary)
      ? "Задание с таймером."
      : /^(?:\/learn\/[^/]+\/(?:programming|lab|exam)\/)/i.test(location.pathname) && !fields.length
        ? "Требуется внешняя среда, лабораторная работа или экзамен."
        : controls(root, /^(?:upgrade|purchase|pay|enroll|verify (?:your )?(?:id|identity)|подтвердить личность)(?:$|\s)/i).length
          ? "Требуется доступ к заданию или подтверждение личности."
          : null;
    const boxes = new Map();
    if (submit.length) for (const node of fields) {
      const box = node.closest(".rc-FileUploadEditView") || questionBox(node);
      if (!boxes.has(box)) boxes.set(box, []);
      boxes.get(box).push(node);
    }
    const bindings = [];
    let unsupported = shown(formRoot, "select,[role=combobox],[role=slider],[role=spinbutton],[role=radio]:not(input),[role=checkbox]:not(input),canvas,iframe")
      .some(node => !node.closest("nav") && !inOtherDialog(node, quizDialog) && !checks.includes(node) && !node.querySelector(inputSelector));
    for (const [box, nodes] of boxes) {
      const grouped = nodes.every(node => node.type === "radio" || node.type === "checkbox");
      if (grouped && new Set(nodes.map(node => node.type)).size !== 1) unsupported = true;
      if (!grouped && nodes.length > 1) unsupported = true;
      if (nodes.some(node => !enabled(node) || node.readOnly || node.multiple)) unsupported = true;
      const first = nodes[0];
      const uploadWidget = first.matches(".rc-FileUploadEditView");
      const instructions = shown(box, "legend,h2,h3,h4,[data-testid*=prompt i],[data-testid*=instruction i],[data-testid*=question-text i]")
        .map(label).filter(Boolean).join("\n") || label(box);
      const partPrompt = box.matches(quizPart) && label(box.querySelector('[data-testid="legend"]'));
      const prompt = partPrompt || (grouped ? instructions : fieldName(first) || instructions) || label(first);
      const options = grouped ? nodes.map((node, index) => ({ id: "o" + (index + 1), position: index + 1, text: fieldName(node) })) : [];
      if (!prompt || options.some(option => !option.text)) unsupported = true;
      const type = grouped ? (first.type === "radio" ? "single" : "multiple")
        : first.type === "file" || uploadWidget ? "file" :
          first.type === "number" || /^(?:numeric|decimal)$/.test(first.inputMode) ? "number" : "text";
      const question = { id: "q" + (bindings.length + 1), position: bindings.length + 1, prompt, type, options };
      if (type === "file") {
        const uploadPrompt = uploadWidget ? shown(box.parentElement, '[data-testid="question-content"]') : [];
        if (uploadPrompt.length === 1) question.prompt = label(uploadPrompt[0]);
        question.accept = first.accept || (/\b(?:single )?zip (?:file|archive)\b/i.test(question.prompt) ? ".zip" : "");
        if (uploadWidget) {
          if (uploadPrompt.length !== 1) unsupported = true;
          question.requirements = question.prompt;
        } else {
          const copy = box.cloneNode(true);
          select(copy, "[data-testid*=upload-status i],[data-testid*=attachment i],[role=status],[aria-live]").forEach(node => node.remove());
          question.requirements = [question.prompt, label(copy), label(first), first.getAttribute("aria-describedby")?.split(/\s+/)
            .map(id => label(document.getElementById(id))).join(" ")].filter(Boolean).join("\n");
        }
      }
      if (first.maxLength > 0) question.maxLength = first.maxLength;
      if (first.minLength > 0) question.minLength = first.minLength;
      bindings.push({ question, nodes, box });
    }
    const instructions = shown(formRoot, '[data-testid*="instruction" i],[data-testid*="rubric" i],[data-testid*="guideline" i],[aria-label*="rubric" i],[data-testid="question-content"],details')
      .filter(node => !node.closest(peerInstructions)).map(instructionText).filter(Boolean).join("\n");
    const scope = peer ? "" : shown(formRoot, "p,legend,h2,h3,h4,li,[data-testid*=description i]")
      .filter(node => !node.closest(materialCard) && !bindings.some(binding => binding.box.contains(node)))
      .map(instructionText).filter(Boolean).join("\n");
    const questions = bindings.map(binding => binding.question);
    const assessment = { key: assignmentKey(), title: quizTitle(root, quizDialog), peer, instructions: [instructions, scope].filter(Boolean).join("\n"),
      questions, signature: JSON.stringify(questions) };
    const upload = fields.some(node => node.matches(".rc-FileUploadEditView")) ||
      select(formRoot, 'input[type=file]').some(node => !inOtherDialog(node, quizDialog) && !node.parentElement.closest(
        '[hidden],[aria-hidden=true],nav,header,' + peerInstructions)) ||
      controls(formRoot, /^(?:(?:add|attach|choose|upload|select) (?:a )?files?|(?:добавить|прикрепить|выбрать|загрузить) файл)$/i).length;
    let fileReason = upload ? "На форме задания есть поле для прикрепления файла." : downloadReason(root);
    if (!fileReason) {
      const intro = shown(root, 'p,[data-testid*="instruction" i]').filter(node =>
        !formRoot.contains(node) && !inOtherDialog(node, quizDialog) && !node.closest('nav,header,footer,aside')).map(label);
      const prompts = questions.filter(question => !question.options.length).map(question => question.prompt);
      fileReason = [assessment.instructions, ...intro, ...prompts].map(instructionFileReason).find(Boolean) || null;
    }
    const visualReason = !peer && visualTask(root, pane, form, boxes, quizDialog)
      ? "В условии или вариантах есть визуальный материал." : null;
    return { view, assessment, bindings, open, retry, feedback, history, submit, checks, unsupported, reason, fileReason, visualReason,
      fieldCount: fields.length };
  }

  function submitButtons(root, quizDialog) {
    const text = /^(?:submit(?: (?:assignment|quiz|my work|my submission|for (?:peer )?review))?|отправить(?: (?:работу|задание|ответы))?)$/i;
    const buttons = shown(root, "button,[role=button],input[type=submit]").filter(node =>
      !inOtherDialog(node, quizDialog) && !node.closest("nav,header,aside") && !node.matches("a"));
    const marked = quizDialog ? buttons.filter(node => node.matches('button[data-testid="submit-button"]')) : [];
    return marked.length ? marked : buttons.filter(node =>
      [label(node), clean(node.innerText), node.value].some(value => value && text.test(value)));
  }

  function response(peer, allowTimed) {
    const state = inspect(peer, allowTimed);
    const { view, assessment, open, retry, feedback, history, submit, unsupported, reason, fileReason, visualReason, fieldCount } = state;
    return { ...view, assessment, open: open.length === 1, retry: retry.length === 1, feedbackLink: feedback.length === 1,
      historyLink: history.length === 1, startDialog: !!assignmentDialog("start"),
      formIssue: submit.length !== 1 ? (submit.length ? "Найдено несколько кнопок Submit." :
        fieldCount ? "Поля видны, но кнопка Submit не найдена." : "Поля ответов и кнопка Submit не найдены.") :
        !assessment.questions.length ? "Кнопка Submit видна, но поля ответов не найдены." : "",
      ready: submit.length === 1 && !!assessment.questions.length, unsupported, reason, fileReason, visualReason };
  }

  function sameForm(peer, expected) {
    const state = inspect(peer, expected.allowTimed);
    if (state.assessment.signature !== expected.signature || state.assessment.key !== expected.key ||
        state.submit.length !== 1 || state.unsupported || state.reason || state.fileReason || state.visualReason) {
      throw new Error("Форма текущего задания изменилась или стала неоднозначной.");
    }
    return state;
  }

  function setText(node, value) {
    node.focus();
    if (node.isContentEditable) {
      node.textContent = value;
    } else {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value").set.call(node, value);
    }
    node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.blur();
  }

  async function attach(node, file) {
    const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], file.name, { type: file.mime }));
    if (node.matches(".rc-FileUploadEditView")) {
      const buttons = controls(node, /^(?:add file|добавить файл)$/i).filter(enabled);
      if (buttons.length !== 1) throw new Error("Кнопка Add File недоступна.");
      buttons[0].click();
      for (let step = 0; step < 24; step++) {
        const drop = shown(document, '[role=dialog] .uppy-Dashboard-AddFiles');
        if (drop.length === 1) {
          drop[0].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
          return;
        }
        await sleep(125);
      }
      throw new Error("Coursera не открыла диалог загрузки Add File.");
    }
    node.files = data.files;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function uploaded(binding, file) {
    const selector = "[data-testid*=upload i],[role=status],[aria-live],[data-testid*=attachment i],button[aria-label],a[download]";
    const evidence = shown(binding.box, selector).filter(node => !node.matches("input")).map(label).join(" ");
    const entire = label(binding.box);
    if (/upload (?:failed|error)|ошибка загрузки|не удалось загрузить/i.test(evidence)) {
      throw new Error("Загрузка файла " + file.name + ": " + evidence.slice(0, 180));
    }
    const escaped = file.name.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&");
    const exact = new RegExp("(^|[^\\p{L}\\p{N}_.-])" + escaped + "(?=$|[^\\p{L}\\p{N}_.-])", "u");
    return exact.test(entire) && !/uploading|загружается/i.test(evidence) &&
      /uploaded|upload complete|(?:remove|delete) (?:file|attachment)|download|загружен|удалить файл/i.test(evidence || entire);
  }

  function verified(peer, expected, answers, applyChecks = false) {
    const state = sameForm(peer, expected);
    const all = state.bindings.every(({ question, nodes, box }, index) => {
      const answer = answers[index];
      if (question.id !== answer?.id) return false;
      if (answer.choices) return nodes.every((node, n) => node.checked === answer.choices.includes(question.options[n].id));
      if (answer.file) {
        const file = nodes[0].files?.[0];
        return (!file || (file.name === answer.file.name && file.size === answer.file.size)) &&
          uploaded({ box }, answer.file);
      }
      return (nodes[0].isContentEditable ? nodes[0].innerText : nodes[0].value) === answer.value &&
        (nodes[0].validity?.valid ?? true) &&
        (!question.maxLength || answer.value.length <= question.maxLength) &&
        (!question.minLength || answer.value.length >= question.minLength);
    });
    if (!all || state.bindings.length !== answers.length) return { step: "fields" };
    if (applyChecks && !confirmChecks(state.checks)) return { step: "checkbox" };
    if (!state.checks.every(checked)) return { step: "checkbox" };
    return enabled(state.submit[0]) ? { button: state.submit[0], checked: state.checks.length } : { step: "button" };
  }

  async function confirmSubmission() {
    for (let step = 0; step < 24; step++) {
      if (assignmentDialog("submit")) {
        if (confirmDialog("submit")) return null;
      } else {
        const view = status();
        if (view.processing || ["passed", "failed", "peer", "submitted"].includes(view.status)) return null;
      }
      await sleep(250);
    }
    return assignmentDialog("submit") ? "Диалог отправки: галочка или кнопка подтверждения осталась недоступной." : null;
  }

  async function fill(peer, expected, answers) {
    sameForm(peer, expected);
    for (let index = 0; index < answers.length; index++) {
      const binding = sameForm(peer, expected).bindings[index];
      const { question, nodes } = binding;
      const answer = answers[index];
      if (answer.choices) {
        for (let n = 0; n < nodes.length; n++) {
          if (question.type === "single" && !answer.choices.includes(question.options[n].id)) continue;
          if (nodes[n].checked !== answer.choices.includes(question.options[n].id)) nodes[n].click();
        }
      } else if (answer.file) await attach(nodes[0], answer.file);
      else setText(nodes[0], answer.value);
    }
  }

  async function submitPrepared({ peer, expected, answers }) {
    if (submittedNonce === expected.nonce) return { clicked: true };
    for (let attempt = 0; attempt < 8; attempt++) {
      let result;
      try { result = verified(peer, expected, answers); }
      catch (error) { return { clicked: false, reason: error.message }; }
      if (result.button) {
        if (submittedNonce === expected.nonce) return { clicked: true };
        submittedNonce = expected.nonce;
        result.button.click();
        return { clicked: true, issue: await confirmSubmission() };
      }
      if (result.step !== "button" || attempt === 7) return { clicked: false, step: result.step };
      await sleep(250);
    }
  }

  globalThis.queueCoursera = async (action, args) => {
    auth();
    if (action === "catalog-ready") return catalogView(args.mode);
    if (action === "catalog") return catalog(args.mode);
    if (action === "tab") {
      const tab = shown(main(), "[role=tab],button").find(node => label(node) === args.label && enabled(node));
      if (!tab) throw new Error("Вкладка списка изменилась.");
      tab.click();
      return true;
    }
    if (action === "next") {
      const next = controls(main(), nextPage)
        .find(node => enabled(node) && node.closest("nav,[role=navigation],[data-testid*=pagin i]"));
      if (!next) throw new Error("Кнопка следующей страницы изменилась.");
      next.click();
      return true;
    }
    if (action === "grades") return grades();
    if (action === "enroll") {
      const { included } = enrollment(args.slug);
      if (!included || !hasPlus() || shown(document, dialogSelector).length) {
        throw new Error("Coursera изменила условия записи или не показывает активный Plus на странице курса.");
      }
      included.click();
      return true;
    }
    if (!args.keys.includes(assignmentKey())) {
      const reason = "Coursera открыла другую страницу задания.";
      if (action === "submit") return { clicked: false, reason };
      throw new Error(reason);
    }
    if (action === "read") return response(args.peer, args.allowTimed);
    if (action === "materials") return materials(args.peer);
    if (action === "submission-tab") {
      const tabs = controls(main(), /^(?:my submission|моя работа)$/i).filter(node => node.matches('[role=tab]') && enabled(node));
      if (tabs.length !== 1) throw new Error("Вкладка My submission не найдена.");
      if (tabs[0].getAttribute("aria-selected") !== "true") tabs[0].click();
      return true;
    }
    if (action === "confirm-start") return confirmDialog("start", args.allowTimed);
    if (action === "open") {
      const state = inspect(args.peer, args.allowTimed);
      if (args.kind === "open" && (assignmentDialog("start") || (state.submit.length === 1 && state.bindings.length))) return true;
      const items = state[args.kind];
      if (!Array.isArray(items) || items.length !== 1 || state.reason ||
          (args.kind === "retry" && (!state.view.remaining || state.view.cooldown || args.peer))) {
        throw new Error("Coursera изменила условия начала попытки.");
      }
      items[0].click();
      return true;
    }
    if (action === "fill") return fill(args.peer, args.expected, args.answers);
    if (action === "verify") {
      const result = verified(args.peer, args.expected, args.answers, true);
      return result.button ? { ready: true, checked: result.checked } : { step: result.step };
    }
    if (action === "submit") return submitPrepared(args);
    throw new Error("Неизвестное действие Coursera.");
  };
})();

