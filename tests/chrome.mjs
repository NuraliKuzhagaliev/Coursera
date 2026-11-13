import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, cp, rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const temp = await mkdtemp(join(tmpdir(), "coursera-mv3-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description, limit = 45000) {
  const end = Date.now() + limit;
  do {
    const value = await read();
    if (value) return value;
    await delay(150);
  } while (Date.now() < end);
  throw new Error("Timeout: " + description);
}
async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: "http://127.0.0.1:" + server.address().port };
}
function cdp(socket) {
  let counter = 0;
  const waiting = new Map();
  socket.addEventListener("message", ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    const waiter = waiting.get(id);
    if (!waiter) return;
    waiting.delete(id);
    if (error) waiter.reject(new Error(error.message));
    else waiter.resolve(result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of waiting.values()) waiter.reject(new Error("DevTools closed"));
    waiting.clear();
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++counter;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function launch(profile, binary = chromePath) {
  await rm(join(profile, "DevToolsActivePort"), { force: true });
  const process = spawn(binary, [
    "--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--enable-unsafe-extension-debugging", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"
  ], { windowsHide: true, stdio: "ignore" });
  const exited = once(process, "exit");
  try {
    const port = await until(async () => (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0].trim(), "DevTools port");
    const details = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
    const socket = new WebSocket(details.webSocketDebuggerUrl);
    await Promise.race([once(socket, "open"), delay(5000).then(() => { throw new Error("DevTools connection timeout"); })]);
    const call = cdp(socket);
    return {
      call,
      async page(url) {
        const { targetId } = await call("Target.createTarget", { url });
        const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
        return async expression => {
          const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result.value;
        };
      },
      async close() {
        await call("Browser.close").catch(() => {});
        socket.close();
        await Promise.race([exited, delay(5000).then(() => process.kill())]);
      }
    };
  } catch (error) {
    process.kill();
    throw error;
  }
}

const fixture = {
  attempts: Object.create(null), opens: [], mode: "initial", badReply: true, modelCalls: 0,
  order: [], errors: [], confirmed: [], materialUploads: [], materialRequests: 0, fileStarts: 0, retryStarts: 0
};
const all = {
  first: ["multi", "file", "file_source", "file_instructions", "file_upload_instruction", "file_materials", "text", "peer"],
  allpassed: ["already_passed"],
  second: ["crash", "uncertain"], single: ["file_single", "text"], "quiz-demo": ["quiz_modal", "quiz_direct", "text"]
};
const sourcePdf = "%PDF-1.4\n% PDF bytes for the attachment transport fixture\n%%EOF\n";
const sourceText = "Exact course requirements\nUse UTF-8: проверка\n";
const status = key => key === "already_passed" ? "Passed" : key === "uncertain" ? "Not started" : !fixture.attempts[key] ? "Not started"
  : ["peer", "file_materials"].includes(key) && fixture.mode !== "graded" ? "Awaiting peer review"
  : key === "text" ? "Awaiting grading"
  : key === "multi" && fixture.attempts[key] === 1 ? "Didn't pass" : "Passed";
const fullQuiz = key => ["quiz_direct", "quiz_blocked"].includes(key);
const statusSlug = key => fullQuiz(key) ? "assignment-submission" :
  ["peer", "file_materials"].includes(key) ? "peer" : "quiz";
const stagedQuiz = key => key === "quiz_modal" || fullQuiz(key);
const gradesOnly = process.argv.includes("--grades");
const quizOnly = process.argv.includes("--quiz");
const timedOnly = process.argv.includes("--timed");
const chatRecoveryOnly = process.argv.includes("--chat-recovery");
const chatRotationOnly = process.argv.includes("--chat-rotation");
const parallelOnly = process.argv.includes("--parallel");
const optionalCoordinatorOnly = process.argv.includes("--optional-coordinator");
const minimumTimeOnly = process.argv.includes("--minimum-time");
const historyOnly = process.argv.includes("--history");
const quizTiming = {};
if (minimumTimeOnly) all["quiz-demo"].push("quiz_zero");
const parallelCourses = { "parallel-first": ["quiz_modal"], "parallel-second": ["quiz_direct"], "parallel-third": ["text"] };
const parallelPrompts = new Set();
let releaseModels;
const modelGate = new Promise(resolve => { releaseModels = resolve; });
Object.assign(all, parallelCourses);
let chatRootVisits = 0;
const promptThreads = [];
let frozenSends = 0;
let rootChatBlocked = chatRecoveryOnly;
if (quizOnly) all["quiz-demo"].push("quiz_blocked");
if (timedOnly) all["quiz-demo"].unshift("visual_prompt", "visual_option");
const quizStages = [];
const enrolled = new Set();
let subscriptionClicks = 0;
const plusBadge = "<button aria-label='User dropdown menu'><span data-testid='tag-root'>" +
  "<span data-testid='visually-hidden'>Status: PLUS</span><span>PLUS</span></span></button>";
let slowAssetFinished = false;
let catalogAssetFinished = false;
let historyAssetFinished = false;
let historyVisits = 0;
const catalogVisits = [];
const taskUrl = (slug, key) => "/learn/" + slug + "/" + statusSlug(key) + "/" + key + "/" + key;
const wrap = body => "<!doctype html><meta charset='utf-8'><main>" + body + "</main>";
function providerPage(provider, freeze = false, stream = false) {
  const gemini = provider === "gemini";
  const modern = !gemini && !gradesOnly;
  const chatComposer = "<form data-chatgpt-composer><div contenteditable='true' role='textbox' data-composer-markdown></div>" +
    "<input hidden type='file' accept='image/*'><input hidden type='file' multiple><div id='chips'></div>" +
    "<button type='button' aria-label='Отправить'>Отправить</button></form>";
  return wrap(
    (gemini ? "<rich-textarea><div class='ql-editor' contenteditable='true'></div></rich-textarea><button class='send-button'>Send</button>" :
      modern ? chatComposer + "<div hidden>" + chatComposer + "<button aria-label='Остановить'>Остановить</button></div>" :
        "<div id='prompt-textarea' contenteditable='true'></div><button data-testid='send-button'>Send</button>") +
    "<section></section><script>" +
    "const editor=document.querySelector('[contenteditable]'), button=document.querySelector('button'), thread=document.querySelector('section');" +
    (chatRotationOnly ? "const threadId=crypto.randomUUID();" : "") +
    "const input=document.querySelector('input[multiple]'), chips=document.querySelector('#chips');let materialNames=[];" +
    "if(input)input.onchange=async()=>{button.disabled=true;chips.setAttribute('aria-busy','true');" +
    "const files=await Promise.all([...input.files].map(async f=>[f.name,f.type,await f.text()]));input.value='';" +
    "await fetch('/materials-received',{method:'POST',body:JSON.stringify(files)});materialNames=files.map(f=>f[0]);" +
    "for(const name of materialNames){const chip=document.createElement('span');chip.title=name;chip.textContent=name;chips.append(chip);}" +
    "setTimeout(()=>{button.disabled=false;chips.removeAttribute('aria-busy');},650);};" +
    "button.onclick=async()=>{const text=editor.innerText;editor.replaceChildren();const user=document.createElement(" + JSON.stringify(gemini ? "user-query" : "div") + ");" +
    (modern ? "user.setAttribute('data-chatgpt-search-unit-key','fixture:user');" : "user.dataset.messageAuthorRole='user';") +
    "user.textContent=text;thread.append(user);const stop=document.createElement('button');stop.setAttribute('aria-label'," +
    JSON.stringify(gemini ? "Stop response" : "Stop generating") + ");stop.textContent='Stop';thread.append(stop);" +
    (freeze ? "await fetch('/freeze',{method:'POST'});return;" : "") +
    (chatRotationOnly ? "history.replaceState(null,'','/c/'+threadId);" : "") +
    "const answer=await(await fetch('/model',{method:'POST',headers:{'x-materials':materialNames.join(',')" +
    (chatRotationOnly ? ",'x-fixture-thread':threadId" : "") + "},body:text})).json();" +
    "materialNames=[];chips?.replaceChildren();const turn=document.createElement(" + JSON.stringify(gemini ? "model-response" : "article") +
    ");const response=document.createElement('div');response.className='model-response-text';" +
    (modern ? "response.setAttribute('data-chatgpt-search-unit-key','fixture:assistant');" +
      "turn.setAttribute('data-talvt-turn-state','streaming');turn.append(response);thread.append(turn);" +
      "const header=document.createElement('h4');header.textContent='ChatGPT сказал:';response.append(header);" +
      "const content=document.createElement('div');content.setAttribute('data-markdown-text-style','default');response.append(content);" :
      "response.dataset.messageAuthorRole='assistant';const content=response;") +
    "if(answer.kind==='attachment'){const link=document.createElement('a');link.download=answer.name;link.textContent=answer.name;" +
    "const blob=()=>URL.createObjectURL(new Blob([answer.content],{type:'text/x-python'}));link.href=answer.href||blob();" +
    "if(answer.href?.startsWith('sandbox:'))link.onclick=e=>{e.preventDefault();const actual=document.createElement('a');actual.href=blob();actual.download=answer.name;document.body.append(actual);actual.click();actual.remove();};content.append(link);}" +
    "else if(answer.kind==='code'){const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=answer.content;pre.append(code);content.append(pre);}" +
    (stream ? "else {const result=JSON.stringify(answer);for(const end of [12,24,36,result.length]){" +
      "content.textContent=result.slice(0,end);await new Promise(r=>setTimeout(r,1800));}}" :
      "else content.textContent=JSON.stringify(answer);") +
    (modern ? "if(materialNames.length || text.includes('Cooja_task.pdf')) await new Promise(r=>setTimeout(r,2500));" +
      "turn.setAttribute('data-talvt-turn-state','complete');" :
      "const done=document.createElement('button');done.setAttribute('aria-label','Copy');done.textContent='Copy';turn.append(response,done);thread.append(turn);") +
    "stop.remove();};</script>");
}
const readBody = async request => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
};
async function model(request, response) {
  const body = await readBody(request);
  fixture.modelCalls++;
  const data = body.split(/\r?\n/).map(line => line.trim()).find(part => part.startsWith('{"title"'));
  if (!data) {
    fixture.errors.push("Prompt payload not found: " + JSON.stringify(body.slice(-700)));
    response.end('{"manual":"malformed fixture prompt","answers":[]}');
    return;
  }
  const task = JSON.parse(data);
  if (minimumTimeOnly) {
    if (task.title === "quiz_direct") await delay(14000);
    (quizTiming[task.title] ||= {}).responseAt = Date.now();
  }
  if (chatRotationOnly) promptThreads.push([task.title, request.headers["x-fixture-thread"]]);
  if (parallelOnly || optionalCoordinatorOnly) {
    parallelPrompts.add(task.title);
    await modelGate;
  }
  const id = body.match(/assignment-[\w-]+/)?.[0];
  response.setHeader("Content-Type", "application/json");
  if (/^(?:file|visual_)/.test(task.title)) {
    fixture.errors.push("Assignment with external materials was sent to the model: " + task.title);
    response.end(JSON.stringify({ requestId: id, manual: "Assignment must be skipped.", answers: [] }));
    return;
  }
  if (task.questions.some(question => question.prompt.includes("First quiz prompt"))) {
    try {
      assert(fullQuiz(task.title), task.title);
      assert.match(task.instructions, /Choose one option per question\./);
      assert.doesNotMatch(body, /Coursera Honor Code|Last saved on|Graded Assignment • 30 min|Fixture Learner/);
      assert.deepEqual(task.questions.map(({ type, prompt, options }) => [type, prompt, options.map(option => option.text)]), [
        ["single", "1. First quiz prompt", ["Alpha", "Beta", "Gamma"]],
        ["multiple", "2. Second quiz prompt", ["Alpha", "Beta", "Gamma"]]
      ]);
    } catch (error) { fixture.errors.push(error.message); }
  }
  let answers = task.questions.map(question => ({
    id: question.id, ...(question.type === "multiple" ? { choices: ["o1", "o3"] } :
      question.type === "single" ? { choices: ["o2"] } :
      question.type === "file" ? { file: { name: "solution.py", content: "print('fixture')\n" } } :
      { value: task.title + " answer" })
  }));
  if (fixture.badReply) {
    fixture.badReply = false;
    answers = [{ id: "q1", choices: ["o9"] }];
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ requestId: id, manual: "", answers }));
}
const feedbackBanner = (score, threshold) => "<div role='alert'><div data-testid='AssignmentViewTopBanner'><h2>Your grade: " +
  score + "%</h2><div>Your latest: " + score + "% • Your highest: " + score +
  "% • To pass you need at least " + threshold + "%. We keep your highest score.</div></div></div>";
const quizPane = (content, key = "quiz_direct", alternative = false) =>
  (alternative ? "<div>" : "<div data-testid='assignment-view-tunnel-vision'>") +
  "<div role='dialog' aria-modal='true' aria-labelledby='quiz-title'><div id='quiz-title'><span>" + key + "</span><p>Graded Assignment • 30 min</p></div>" +
  "<div data-testid='tunnel-vision-content'>" + content + "</div></div></div>";
const image = (extra = "") => "<img alt='' width='80' height='45' src='data:image/gif;base64,R0lGODlhAQABAAAAACw=' " + extra + ">";

function fullscreenQuiz(key) {
  const parts = ["First", "Second"].map((prompt, index) => {
    const part = index === 0 ? "MultipleChoiceQuestion" : "CheckboxQuestion";
    const type = index === 0 ? "radio" : "checkbox";
    return "<div role='group' data-testid='part-Submission_" + part + "'><div data-testid='legend'><h3>" +
      (index + 1) + ".</h3><div data-testid='cml-viewer'>" + prompt + " quiz prompt</div></div><div role='" +
      (index === 0 ? "radiogroup" : "group") + "'>" + ["Alpha", "Beta", "Gamma"].map(option =>
        "<label><input type='" + type + "' name='question-" + index + "'>" + option +
        (index === 1 ? "<svg aria-hidden='true'></svg>" + image("role='presentation'") : "") + "</label>"
      ).join("") + "</div></div>";
  }).join("");
  return "<!doctype html><meta charset='utf-8'><main><h1>Background course screen</h1><textarea>Ignore this field</textarea></main>" +
    "<div role='dialog'>Chat with us</div>" + quizPane(parts +
    "<p>Time limit: 50 minutes per attempt.</p><p>Choose one option per question.</p><div data-testid='HonorCodeAgreement'>" +
    "<h3>Coursera Honor Code</h3><p>I, Fixture Learner, confirm this work is my own.</p>" +
    "<label><input id='honor' type='checkbox' required>I confirm this is my own work</label></div>" +
    "<p role='status'>Last saved on Nov 11, 12:28 AM +06</p>" +
    (quizOnly ? "<button>Submit</button>" : "") +
    "<button data-testid='submit-button' aria-label='Submit your answers for grading' disabled>Submit</button>" +
    "<dialog><h2>Ready to submit?</h2><button>Submit</button><button>Cancel</button></dialog>", key, quizOnly) +
    "<script>const honor=document.querySelector('#honor'), submit=document.querySelector('[data-testid=submit-button]'), dialog=document.querySelector('dialog');" +
    "honor.onchange=()=>{submit.disabled=!honor.checked;" +
    (quizOnly ? "if(honor.checked)queueMicrotask(()=>{submit.disabled=true;" +
      (key === "quiz_blocked" ? "" : "setTimeout(()=>{submit.disabled=!honor.checked;},700);") + "});" : "") +
    "};submit.onclick=async()=>{" +
    "await fetch('/quiz-stage/submit',{method:'POST'});dialog.showModal();};dialog.querySelector('button').onclick=async()=>{" +
    "dialog.innerHTML='<h2>Ready to submit?</h2><p role=\"status\">Submitting...</p>';await new Promise(r=>setTimeout(r,1500));" +
    "dialog.close();const choices=[...document.querySelectorAll('[data-testid^=part-Submission_] input')].map(x=>x.checked);" +
    "await fetch('/submitted/" + key + "',{method:'POST',body:JSON.stringify({choices,confirmed:honor.checked,dialogConfirmed:true})});" +
    "document.querySelector('[data-testid=tunnel-vision-content]').innerHTML='<h2>Reviewing your submission...</h2><p>Hang tight.</p>';" +
    "await new Promise(r=>setTimeout(r,1500));location.replace(location.pathname+'?feedback=open');};</script>";
}

function assignment(key, { active, showHistory, showFeedback }) {
  const grade = status(key);
  const count = fixture.attempts[key] || 0;
  const demoQuiz = stagedQuiz(key);
  const modalStart = key === "quiz_modal";
  if (key === "visual_prompt") {
    return wrap(quizPane("<div data-testid='part-Submission_MultipleFillableBlanksQuestion'><div data-testid='legend'>" +
      "<div data-testid='cml-viewer'>Use the circuit below." + image() + image() +
      "</div></div><div aria-busy='true'>Loading answer fields</div></div>" +
      "<button data-testid='submit-button'>Submit</button>", key));
  }
  if (key === "visual_option") {
    return wrap("<h1>visual_option</h1><form><fieldset><legend>Which diagram matches?</legend>" +
      "<label><input type='checkbox'>A " + image() + "</label><label><input type='checkbox'>B</label>" +
      "</fieldset><button type='submit'>Submit</button></form>");
  }
  if (fullQuiz(key) && active) return fullscreenQuiz(key);
  if (key === "quiz_direct" && count) {
    if (showFeedback) return wrap(quizPane(feedbackBanner("83.33", "80")));
    const result = "<div data-testid='result-banner'><p>You passed!</p><span data-testid='grade'>83.33%</span></div>";
    if (!showHistory) return wrap("<h1>quiz_direct</h1>" + result + "<a href='?history=open'>Attempt history</a>");
    historyVisits++;
    const rows = "<div data-testid='attempt-history'><table><tbody><tr data-attempt-id='quiz-attempt-1'><td data-testid='attempt-status'>Passed</td></tr></tbody></table></div>";
    return wrap("<h1>quiz_direct</h1><img src='/unfinished-history.png' alt=''><div id='attempts'></div>" +
      "<script>setTimeout(()=>document.querySelector('#attempts').innerHTML=" + JSON.stringify(rows) + ",900)</script>");
  }
  if (demoQuiz && !count && !active) {
    const startModal = timedOnly
      ? "<dialog aria-labelledby='start-title'><h2 id='start-title'>Start new attempt?</h2>" +
        "<p>You have 50 minutes to submit up to 1 time for this attempt.</p>" +
        "<p>You will have 2 attempts left after the time runs out. After that, you will have to wait 24h before you can try again.</p>" +
        "<button id='confirm-start'>Continue</button><button>Cancel</button></dialog>"
      : "<dialog><h2>Start this assignment?</h2><p>Time limit: 50 minutes.</p><button id='confirm-start'>Confirm</button></dialog>";
    return wrap("<h1>" + key + "</h1><p>3 attempts</p>" + (modalStart ? "" : "<p>50 min per attempt</p>") +
      "<button id='begin'>Start assignment</button>" +
      (modalStart ? startModal : "") +
      "<script>document.querySelector('#begin').onclick=async()=>{await fetch('/quiz-stage/start',{method:'POST'});" +
      (modalStart ? "document.querySelector('dialog').showModal();};document.querySelector('#confirm-start').onclick=async()=>{" +
        "await fetch('/quiz-stage/confirm-start',{method:'POST'});location.search='?attempt=open';};" :
        "location.href=location.pathname.replace('/assignment-submission/','/quiz/')+'?attempt=open';};") + "</script>");
  }
  if (demoQuiz && count && !active) {
    const result = "<div data-testid='result-banner'><p>You passed!</p><span data-testid='grade'>100%</span></div>" +
      "<div data-testid='attempt-history'><table><tbody><tr data-attempt-id='quiz-attempt-1'><td data-testid='attempt-status'>Passed</td></tr></tbody></table></div>";
    return wrap("<h1>" + key + "</h1><p data-testid='submission-status'>Submitted</p><div id='result'></div>" +
      "<script>setTimeout(()=>document.querySelector('#result').innerHTML=" + JSON.stringify(result) + ",1400)</script>");
  }
  if (key === "multi" && count) {
    return wrap("<h1>multi</h1>" + feedbackBanner("60", "80") + "<p>2 attempts remaining</p>" +
      "<button onclick='fetch(\"/retry-started\");location.search=\"?attempt=retry\"'>Try again</button>");
  }
  if (grade !== "Not started" && !active) {
    return wrap("<h1>" + key + "</h1><div data-testid='submission-status'>" + grade +
      "</div><div data-testid='attempt-history'><table><tbody><tr data-attempt-id='" + count +
      "'><td data-testid='attempt-status'>" + grade + "</td></tr></tbody></table></div>" +
      (key === "peer" ? "<button>Review peers</button>" : "") +
      (grade === "Didn't pass" ? "<p>2 attempts remaining</p><div data-testid='assignment-feedback'>Detailed feedback</div>" +
        "<button onclick='location.search=\"?attempt=retry\"'>Try again</button>" : ""));
  }
  if (key === "file_materials") {
    return wrap("<h1>file_materials</h1><div role='tablist'><button role='tab' aria-selected='true'>Instructions</button>" +
      "<button role='tab' aria-selected='false'>My submission</button></div>" +
      "<div role='tabpanel'><div data-testid='peer-assignment-instructions'><div data-testid='cml-viewer'>" +
      "<p>Read the course manual and use the starter file.</p><div data-testid='video-player'>Video duration <button>Playback speed</button></div>" +
      "<div data-testid='asset-v2-wrapper'><a href='/api/rest/v1/asset/download/pdf/manual'>Cooja_task.pdf<br>PDF File</a></div>" +
      "<div data-testid='asset-v2-wrapper'><a href='/api/rest/v1/asset/download/pdf/manual'>Cooja_task.pdf<br>PDF File</a></div>" +
      "<div data-testid='asset-v2-wrapper'><a href='/api/rest/v1/asset/download/file/starter'>starter.txt<br>Text File</a></div>" +
      "</div></div></div><div role='tabpanel' hidden><input aria-label='Project Title'>" +
      "<div><div data-testid='question-content'>Submit your project as a single zip file</div>" +
      "<div class='rc-FileUploadEditView'><div class='rc-UppyFileUploader'><button id='add'>Add File</button></div>" +
      "<div role='status'></div></div></div>" +
      "<label><input type='checkbox' required id='honor'>I confirm this is my own work</label><button id='submit' disabled>Submit</button>" +
      "</div><dialog role='dialog'><div class='uppy-Dashboard-AddFiles'>Drop files here</div></dialog>" +
      "<script>const tabs=[...document.querySelectorAll('[role=tab]')],panels=[...document.querySelectorAll('[role=tabpanel]')];" +
      "tabs.forEach((tab,i)=>tab.onclick=()=>tabs.forEach((item,j)=>{item.setAttribute('aria-selected',String(i===j));panels[j].hidden=i!==j;}));" +
      "const dialog=document.querySelector('dialog'),submit=document.querySelector('#submit'),honor=document.querySelector('#honor');let file;" +
      "document.querySelector('#add').onclick=()=>dialog.showModal();" +
      "dialog.firstElementChild.ondrop=e=>{e.preventDefault();file=e.dataTransfer.files[0];dialog.close();" +
      "document.querySelector('[role=status]').textContent='Uploaded: '+file.name;document.querySelector('#add').remove();};" +
      "honor.onchange=()=>{submit.disabled=!file||!honor.checked;};submit.onclick=async()=>{" +
      "const bytes=[...new Uint8Array(await file.arrayBuffer())];const body={confirmed:honor.checked,dialogConfirmed:true,name:file.name,bytes," +
      "title:document.querySelector('[aria-label=\"Project Title\"]').value};" +
      "await fetch('/submitted/file_materials',{method:'POST',body:JSON.stringify(body)});location.reload();};</script>");
  }
  if (key === "uncertain" && count) return wrap("<h1>uncertain</h1><button>Start assignment</button>");
  if (key === "file_instructions") {
    return wrap("<h1>file_instructions</h1><p>Please download the starter dataset before answering.</p>" +
      "<button onclick='fetch(\"/file-started\")'>Start assignment</button>");
  }
  const field = key === "multi" || demoQuiz
    ? "<label><input type='checkbox'>A. Alpha</label><label><input type='checkbox'>B. Beta</label><label><input type='checkbox'>C. Gamma</label>"
    : ["file", "file_single"].includes(key) ? "<label>Source code <input type='file' accept='.py'></label><div data-testid='upload-status'></div>"
    : "<label>Your response <textarea required></textarea></label>";
  const source = key === "file_source" ? "<a href='/api/rest/v1/asset/download/pdf/manual'>Cooja_task.pdf</a>" :
    key === "file_upload_instruction" ? "<p>Please upload your work as a PDF file.</p>" : "";
  return wrap("<h1>" + key + "</h1>" + source + "<form><fieldset><legend>1. " + key + " prompt</legend>" + field +
    "</fieldset><label><input required type='checkbox' id='honor'>I confirm this is my own work</label>" +
    "<button type='submit' disabled>Submit</button></form>" +
    (demoQuiz ? "<dialog><h2>Are you sure you want to submit?</h2><button>Confirm</button></dialog>" :
      key === "peer" ? "<dialog><h2>Confirm your submission</h2><label><input type='checkbox' required id='dialogCheck'>I confirm sending this work</label><button disabled>Confirm submission</button></dialog>" : "") +
    "<script>const form=document.querySelector('form'), file=form.querySelector('input[type=file]'), honor=form.querySelector('#honor'), submit=form.querySelector('button');" +
    "const dialog=document.querySelector('dialog');let uploaded=false;const toggle=()=>{submit.disabled=!honor.checked||(file&&!uploaded)};honor.onchange=toggle;" +
    "if(file)file.onchange=()=>{document.querySelector('[data-testid=upload-status]').textContent='Uploading';setTimeout(()=>{uploaded=true;document.querySelector('[data-testid=upload-status]').textContent='Uploaded: '+file.files[0].name;toggle();},400);};" +
    "const send=async()=>{submit.disabled=true;const body=file?{name:file.files[0].name,content:await file.files[0].text()}:form.querySelector('textarea')?{text:form.querySelector('textarea').value}:" +
    "{choices:[...form.querySelectorAll('fieldset input')].map(x=>x.checked)};" +
    "const result=await fetch('/submitted/" + key + "',{method:'POST',body:JSON.stringify({...body,confirmed:honor.checked,dialogConfirmed:!dialog||!dialog.querySelector('input')||dialog.querySelector('input').checked})});" +
    (key === "crash" || key === "uncertain" ? "" : "if(result.ok)location.replace(location.pathname);") +
    "};form.onsubmit=async e=>{e.preventDefault();if(submit.disabled)return;" +
    (demoQuiz ? "await fetch('/quiz-stage/submit',{method:'POST'});" : "") +
    "if(dialog)dialog.showModal();else void send();};" +
    "if(dialog){const check=dialog.querySelector('input'),button=dialog.querySelector('button');if(check)check.onchange=()=>{button.disabled=!check.checked;};" +
    "button.onclick=()=>{dialog.close();void send();};}</script>");
}

const coursera = await serve((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const path = url.pathname;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if ((quizOnly || timedOnly || chatRecoveryOnly || chatRotationOnly || parallelOnly) &&
      path.startsWith("/quiz-stage/") && request.method === "POST") {
    quizStages.push(path.split("/").at(-1));
    response.end("ok");
  } else if ((gradesOnly && ["/unfinished.png", "/unfinished-catalog.png"].includes(path)) ||
      ((quizOnly || chatRecoveryOnly) && path === "/unfinished-history.png")) {
    const timer = setTimeout(() => {
      if (path === "/unfinished.png") slowAssetFinished = true;
      else if (path === "/unfinished-catalog.png") catalogAssetFinished = true;
      else historyAssetFinished = true;
      response.end();
    }, 30000);
    response.on("close", () => clearTimeout(timer));
  } else if (path === "/api/rest/v1/asset/download/pdf/manual") {
    fixture.materialRequests++;
    response.writeHead(200, { "Content-Type": "application/pdf" }).end(sourcePdf);
  } else if (path === "/api/rest/v1/asset/download/file/starter") {
    fixture.materialRequests++;
    if (request.headers["sec-fetch-mode"] === "cors") response.writeHead(403).end();
    else response.writeHead(200, { "Content-Type": "text/plain" }).end(sourceText);
  } else if (path === "/file-started") {
    fixture.fileStarts++;
    response.end("ok");
  } else if (path === "/retry-started") {
    fixture.retryStarts++;
    response.end("ok");
  } else if (gradesOnly && ["/switch-subscription", "/checkout"].includes(path)) {
    subscriptionClicks++;
    response.end(wrap("<h1>Subscription checkout</h1>"));
  } else if (path.startsWith("/submitted/")) {
    void readBody(request).then(body => {
      const key = path.split("/").at(-1);
      if (minimumTimeOnly) (quizTiming[key] ||= {}).submittedAt = Date.now();
      try {
        const actual = JSON.parse(body);
        if (key === "quiz_slow") assert.equal(slowAssetFinished, false);
        assert(actual.confirmed && actual.dialogConfirmed, "required confirmation was not checked");
        fixture.confirmed.push(key);
        if (stagedQuiz(key)) quizStages.push("confirm-submit");
        if (key === "quiz_direct") assert.deepEqual(actual.choices, [false, true, false, true, false, true]);
        else if (key === "multi" || stagedQuiz(key)) assert.deepEqual(actual.choices, [true, false, true]);
        else if (key.startsWith("file")) assert.fail("File-dependent assignment was submitted: " + key);
        else assert.equal(actual.text, key + " answer");
      } catch (error) { fixture.errors.push(error.message); }
      fixture.attempts[key] = (fixture.attempts[key] || 0) + 1;
      fixture.order.push(key);
      response.end("ok");
    });
  } else if (path === "/my-learning") {
    const view = url.searchParams.get("view");
    const tabs = "<nav><a href='/my-learning'>In progress</a> <a href='/my-learning?view=completed'>Completed</a> <a href='/my-learning?view=certs'>Certificates</a></nav>";
    const item = slug => "<article><h2>" + slug + "</h2><a href='/learn/" + slug + "'>" + slug + "</a></article>";
    if (timedOnly || chatRotationOnly || optionalCoordinatorOnly) return response.end(wrap(item("quiz-demo")));
    if (historyOnly) return response.end(wrap(item("allpassed")));
    if (parallelOnly) return response.end(wrap(Object.keys(parallelCourses).map(item).join("")));
    if (gradesOnly) {
      const section = url.searchParams.get("myLearningTab");
      if (!section) {
        response.writeHead(302, { Location: "/my-learning?myLearningTab=IN_PROGRESS" }).end();
        return;
      }
      const page = Number(url.searchParams.get("page") || 1);
      catalogVisits.push([section, page]);
      const sections = [["IN_PROGRESS", "In Progress"], ["COMPLETED", "Completed"], ["CERTIFICATES", "Certificates"]];
      const tabMarkup = sections.map(([key, title]) =>
        "<button id='cds-fixture-tab-" + key + "' role='tab' aria-selected='" + (section === key) + "'>" + title + "</button>").join("");
      const pagination = current => "<nav data-testid='pagination-controls'><button aria-label='Page number " +
        current + "'>" + current + "</button><button aria-label='Go to next page'" +
        (current === 2 ? " disabled" : "") + ">Next</button></nav>";
      const firstPage = item("slow") + pagination(1);
      const lastPage = item("paid") + item("no-plus") + item("checkout-target") + pagination(2);
      const content = section === "CERTIFICATES" ? "<p>No certificates yet</p>" :
        section === "COMPLETED" ? item("included") : page === 1 ? firstPage : lastPage;
      response.end(wrap(plusBadge +
        "<div role='tablist'>" + tabMarkup + "</div>" +
        "<section role='tabpanel' aria-labelledby='cds-fixture-tab-" + section + "' aria-busy='true'><p>Loading</p></section>" +
        "<img src='/unfinished-catalog.png' alt=''><script>" +
        "const panel=document.querySelector('[role=tabpanel]');" +
        "setTimeout(()=>{panel.innerHTML=" + JSON.stringify(content) + ";panel.removeAttribute('aria-busy');" +
        "const next=panel.querySelector('[aria-label=\"Go to next page\"]:not([disabled])');" +
        "if(next)next.onclick=()=>{history.pushState({},'', '?myLearningTab=IN_PROGRESS&page=2');panel.setAttribute('aria-busy','true');" +
        "setTimeout(()=>{panel.innerHTML=" + JSON.stringify(lastPage) + ";panel.removeAttribute('aria-busy');},1000);};},1500);</script>"));
      return;
    }
    if (view === "certs") {
      response.end(wrap(tabs + "<article><h2>certified</h2><p>Course Certificate</p><a href='/account/accomplishments/verify/FIXTURECERT'>View certificate</a></article>"));
    } else if (view === "completed") response.end(wrap(tabs + item("certified") + item("first")));
    else if (url.searchParams.has("page")) response.end(wrap(tabs + item("second")));
    else response.end(wrap(tabs + item("first") + (fixture.mode === "graded" ? "" : item("allpassed")) + "<button onclick='this.before(document.getElementById(\"certified-template\").content.cloneNode(true));this.remove()'>Show more</button>" +
      "<template id='certified-template'>" + item("certified") + "</template><nav><a rel='next' href='/my-learning?page=2'>Next page</a></nav>"));
  } else if (path.endsWith("/home/assignments")) {
    const slug = path.split("/")[2];
    fixture.opens.push(slug);
    if (gradesOnly && slug !== "slow" && !enrolled.has(slug)) {
      response.writeHead(302, { Location: "/learn/" + slug }).end();
      return;
    }
    if (gradesOnly) {
      const key = "quiz_" + slug;
      const row = "<tr data-testid='ungrouped-non-peer-assignment-row'><td><a href='" + taskUrl(slug, key) + "'>" +
        key + "</a></td><td>" + status(key) + "</td></tr>";
      response.end(wrap("<h2>Grades</h2><table><thead><tr><th>Assignment</th><th>Status</th></tr></thead><tbody></tbody></table>" +
        (slug === "slow" ? "<img src='/unfinished.png' alt=''>" : "") +
        "<script>setTimeout(()=>document.querySelector('tbody').innerHTML=" + JSON.stringify(row) + ",2200)</script>"));
      return;
    }
    response.end(wrap("<h1>Grades</h1><table><thead><tr><th>Assignment</th><th>Status</th></tr></thead><tbody>" +
      (all[slug] || []).map(key => "<tr><td><a href='" + taskUrl(slug, key) + "'>" + key + "</a></td><td>" +
        (key === "crash" ? "Not started" : status(key)) +
        (key === "peer" && fixture.attempts.peer ? " <button>Review peers</button>" : "") + "</td></tr>").join("") +
      (slug === "first" ? "<tr><td>Review 3 peers' assignments.</td><td>--</td></tr>" : "") + "</tbody></table>"));
  } else if (gradesOnly && ["/learn/included", "/learn/paid", "/learn/no-plus", "/learn/checkout-target"].includes(path)) {
    const slug = path.split("/")[2];
    if (url.searchParams.get("action") === "enroll") {
      enrolled.add(slug);
      response.writeHead(303, { Location: path + "/home/module/1" }).end();
    } else {
      response.end(wrap((slug === "no-plus" ? "" : plusBadge) +
        "<form method='get' action='" + path + "'><input type='hidden' name='action' value='enroll'>" +
        "<button type='submit' data-e2e='enroll-button'" + (slug === "checkout-target" ? " formaction='/checkout'" : "") + ">Enroll" +
        (slug === "paid" ? " for free" : "<span>Included with Coursera Plus</span>") + "</button></form>" +
        "<button type='button' data-testid='xdp-cplus-monthly-to-annual-button' onclick='location.href=\"/switch-subscription\"'>" +
        "Switch subscription <span>Save $15/mo with Coursera Plus annual</span></button>"));
    }
  } else if (gradesOnly && path === "/learn/included/home/module/1") {
    response.end(wrap("<nav><a href='/learn/included/home/assignments'>Grades</a></nav>"));
  } else if (/^\/learn\/.+\/(quiz|peer|assignment-submission)\//.test(path)) {
    response.end(assignment(path.split("/")[4], { active: url.searchParams.has("attempt"),
      showHistory: url.searchParams.has("history"), showFeedback: url.searchParams.has("feedback") }));
  }
  else response.end(wrap("<h1>Fixture</h1>"));
});
const primary = await serve((request, response) => {
  if (request.url === "/model") void model(request, response);
  else if (request.url === "/freeze") {
    frozenSends++;
    response.end("ok");
  }
  else if (request.url === "/materials-received") void readBody(request).then(body => {
    fixture.materialUploads.push(...JSON.parse(body));
    response.end("ok");
  });
  else if (request.url === "/c/full") response.end(wrap("<div role='alert'>You've reached the maximum length for this conversation.</div>"));
  else if (request.url === "/c/frozen") response.end(providerPage("chatgpt", true));
  else if (request.url === "/" || request.url === "/limited" || request.url === "/c/account-limited") {
    if (request.url === "/") chatRootVisits++;
    if (request.url !== "/" || rootChatBlocked) response.end(wrap("<div role='alert'>You've reached your usage limit</div>"));
    else response.end(providerPage("chatgpt", false, chatRecoveryOnly && frozenSends > 0));
  }
  else response.end(providerPage("chatgpt"));
});
const gemini = await serve((request, response) => {
  if (request.url === "/model") void model(request, response);
  else response.end(providerPage("gemini"));
});

let browser, edge, coordinator;
async function startCoordinator(port = 0) {
  const process = spawn("python", ["-B", "helper/coordinator.py", "--data-dir", join(temp, "parallel"), "--port", String(port)],
    { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(process, "exit");
  const output = createInterface({ input: process.stdout });
  const line = await Promise.race([once(output, "line").then(([line]) => line), exited.then(([code]) => {
    throw new Error("Coordinator exited: " + code);
  })]);
  const [, actualPort, key] = line.match(/127\.0\.0\.1:(\d+).*key: ([a-f0-9]{32})/);
  return { origin: "http://127.0.0.1:" + actualPort, port: Number(actualPort), key,
    async close() { process.kill(); await exited; output.close(); } };
}
const host = "org.coursera_queue.files_test_" + randomBytes(6).toString("hex");
const registry = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + host;
const report = result => console.log(result);
try {
  if (parallelOnly || optionalCoordinatorOnly) coordinator = await startCoordinator();
  const testExtension = join(temp, "extension");
  await cp("src", join(testExtension, "src"), { recursive: true });
  await cp("ui", join(testExtension, "ui"), { recursive: true });
  const replace = [
    ["https://www.coursera.org", coursera.origin],
    ["https://chatgpt.com", primary.origin],
    ["https://gemini.google.com", gemini.origin],
    ["org.coursera_queue.files", host]
  ];
  if (coordinator) replace.push(["http://127.0.0.1:8716", coordinator.origin]);
  for (const [source, destination] of [["manifest.json", "manifest.json"], ["src/config.js", "src/config.js"]]) {
    let file = await readFile(source, "utf8");
    for (const [from, to] of replace) file = file.replaceAll(from, to);
    if ((parallelOnly || optionalCoordinatorOnly) && source === "manifest.json") {
      // A headless browser cannot accept the native optional-permission prompt.
      const manifest = JSON.parse(file);
      manifest.host_permissions.push(...manifest.optional_host_permissions);
      delete manifest.optional_host_permissions;
      file = JSON.stringify(manifest);
    }
    await writeFile(join(testExtension, destination), file);
  }
  if (chatRecoveryOnly) {
    const worker = join(testExtension, "src", "worker.js");
    const script = await readFile(worker, "utf8");
    const faster = script.replace("const replyTimeout = { waiting: 180000, generating: 300000 };",
      "const replyTimeout = { waiting: 3500, generating: 5000 };");
    assert.notEqual(faster, script, "the test must shorten the wait without changing recovery logic");
    await writeFile(worker, faster);
  }
  const profile = join(temp, "profile");
  const downloads = join(temp, "downloads");
  await mkdir(downloads);
  await mkdir(join(profile, "Default"), { recursive: true });
  await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloads, directory_upgrade: true, prompt_for_download: false }
  }));
  browser = await launch(profile);
  const prod = await browser.call("Extensions.loadUnpacked", { path: resolve(".") });
  assert.match(prod.id, /^[a-p]{32}$/);
  report("PASS production MV3 loads unpacked in Chrome");
  if (process.env.COURSERA_CHECK_INSTALLED_HOST === "1") {
    const prodUi = await browser.page("chrome-extension://" + prod.id + "/ui/index.html");
    await until(() => prodUi("!!document.getElementById('native') && document.readyState==='complete'"), "production dashboard");
    assert.deepEqual(await prodUi("chrome.runtime.sendMessage({action:'native'})"), { ok: true });
    report("PASS installed user-level Native Messaging registration from isolated Chrome");
  }
  const { id } = await browser.call("Extensions.loadUnpacked", { path: testExtension });
  const testHelper = join(temp, "helper");
  await cp("helper", testHelper, { recursive: true, filter: source => !source.endsWith(".native") });
  const installer = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(testHelper, "install.ps1"), "-ExtensionId", id, "-Downloads", downloads, "-HostName", host],
  { windowsHide: true, stdio: "inherit" });
  assert.equal((await once(installer, "exit"))[0], 0, "native helper installation");
  const dashboard = "chrome-extension://" + id + "/ui/index.html";
  let evaluate = await browser.page(dashboard);
  const getState = () => evaluate("chrome.storage.local.get('state').then(result=>result.state)");
  await until(() => evaluate("!!document.getElementById('start') && document.readyState==='complete'"), "dashboard");
  await browser.page(primary.origin + (chatRecoveryOnly ? "/c/account-limited" : timedOnly ? "/limited" : "/"));
  await evaluate("chrome.runtime.sendMessage(" + JSON.stringify({
    action: "settings", settings: { provider: "chatgpt", fallback: !chatRecoveryOnly }
  }) + ")");
  if (gradesOnly) {
    fixture.badReply = false;
    await evaluate("document.getElementById('start').click()");
    await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done";
    }, "catalog, Grades and enrollment workflow", 120000).catch(async error => {
      throw new Error(error.message + " / " + JSON.stringify({ state: await getState(), fixture }));
    });
    const state = await getState();
    assert.deepEqual([...enrolled], ["included"]);
    assert.deepEqual(fixture.order, ["quiz_slow", "quiz_included"], JSON.stringify(state.courses));
    assert.match(state.courses.paid.reason, /требует записи/);
    assert.match(state.courses["no-plus"].reason, /Plus на странице курса не подтверждён/);
    assert.match(state.courses["checkout-target"].reason, /требует записи/);
    assert.equal(subscriptionClicks, 0);
    assert.equal(catalogAssetFinished, false);
    assert.deepEqual(catalogVisits.slice(0, 4), [["IN_PROGRESS", 1], ["IN_PROGRESS", 2], ["COMPLETED", 1], ["CERTIFICATES", 1]]);
    assert.deepEqual(fixture.errors, []);
    report("PASS enrollment with real form and Plus badge markup, delayed Grades, and no subscription or checkout clicks");
  } else if (optionalCoordinatorOnly) {
    fixture.badReply = false;
    await until(() => evaluate("document.getElementById('chat-requests').valueAsNumber === 30"), "default settings");
    assert.equal(await evaluate("document.getElementById('parallel-enabled').checked"), false);
    assert.equal(await evaluate("document.getElementById('parallel-key').disabled"), true);
    const key = coordinator.key;
    const port = coordinator.port;
    await evaluate("document.getElementById('parallel-enabled').click();" +
      "document.getElementById('parallel-key').value=" + JSON.stringify(key) +
      ";document.getElementById('settings').requestSubmit()");
    await until(() => evaluate("document.getElementById('notice').textContent === 'Настройки сохранены.'"), "enable coordinator");
    await evaluate("document.getElementById('start').click()");
    await until(() => parallelPrompts.size === 1, "assigned course reaching model");
    const assigned = (await getState()).parallelCourse;
    assert.equal(assigned.slug, "quiz-demo");
    assert(!assigned.done);
    await evaluate("document.getElementById('pause').click()");
    await until(async () => (await getState())?.mode === "paused", "pause the assigned course");
    await evaluate("chrome.storage.local.get('settings').then(({settings})=>{" +
      "delete settings.parallelEnabled;return chrome.storage.local.set({settings});})");
    await browser.close();
    browser = null;
    releaseModels();
    await coordinator.close();
    coordinator = null;
    browser = await launch(profile);
    assert.equal((await browser.call("Extensions.loadUnpacked", { path: testExtension })).id, id);
    evaluate = await browser.page(dashboard);
    await browser.page(primary.origin + "/");
    await until(() => evaluate("document.getElementById('parallel-enabled')?.checked"), "migrate legacy enabled setting");
    await evaluate("document.getElementById('parallel-enabled').click();document.getElementById('settings').requestSubmit()");
    await until(() => evaluate("document.getElementById('notice').textContent === 'Настройки сохранены.'"),
      "disable coordinator with an assigned course while it is offline");
    const settings = await evaluate("chrome.storage.local.get('settings').then(({settings})=>settings)");
    assert.equal(settings.parallelEnabled, false);
    assert.equal(settings.parallelKey, key);
    assert.equal((await getState()).parallelCourse.slug, assigned.slug);
    assert.deepEqual(await evaluate("chrome.runtime.sendMessage({action:'resume'})"), { ok: true });
    const solo = await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done" && state;
    }, "resume without coordinator", 90000);
    assert.equal(solo.parallel, null);
    assert.equal(solo.parallelCourse.done, true);
    assert.equal(solo.courses["quiz-demo"].tasks["/learn/quiz-demo/quiz/quiz_modal"].grade, "100%");
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "text"]);
    const target = coursera.origin + taskUrl("quiz-demo", "quiz_modal");
    await evaluate("document.getElementById('single-url').value=" + JSON.stringify(target) +
      ";document.getElementById('single').requestSubmit()");
    await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done" && state.single?.url === target;
    }, "single quiz is available with a saved coordinator code", 45000);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "text"]);
    await evaluate("document.getElementById('parallel-enabled').click();document.getElementById('settings').requestSubmit()");
    await until(() => evaluate("chrome.storage.local.get('settings').then(({settings})=>settings.parallelEnabled)"), "enable the saved code again");
    await evaluate("document.getElementById('start').click()");
    const offline = await until(async () => {
      const state = await getState();
      return state?.mode === "paused" && state;
    }, "coordinator is required only when enabled");
    assert.match(offline.reason, /Координатор недоступен/);
    coordinator = await startCoordinator(port);
    assert.equal(coordinator.key, key);
    assert.deepEqual(await evaluate("chrome.runtime.sendMessage({action:'resume'})"), { ok: true });
    const rejoined = await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done" && state;
    }, "finish the retained assignment when rejoining", 90000);
    assert.equal(rejoined.parallelCourse, undefined);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "text"]);
    assert.deepEqual(fixture.errors, []);
    report("PASS optional coordinator: migrate legacy settings, disable offline with an assigned course, resume and use single quiz, then rejoin without duplicate submissions");
  } else if (historyOnly) {
    const archived = {
      withdrawn: {
        slug: "withdrawn", url: "/learn/withdrawn", title: "Withdrawn course", status: "manual",
        reason: "Saved course reason", tasks: {
          "/learn/withdrawn/quiz/old": { key: "/learn/withdrawn/quiz/old", url: "/learn/withdrawn/quiz/old",
            title: "Saved quiz", status: "failed", grade: "75%", reason: "Saved task reason" }
        }
      },
      "hidden-history": {
        slug: "hidden-history", url: "/learn/hidden-history", title: "Previously hidden course", status: "manual",
        tasks: {
          "/learn/hidden-history/quiz/file": { key: "/learn/hidden-history/quiz/file",
            url: "/learn/hidden-history/quiz/file", title: "Saved file assignment", status: "skippedFiles",
            reason: "Saved file reason" }
        }
      },
      "certified-old": {
        slug: "certified-old", url: "/learn/certified-old", title: "Old certificate", status: "certificate", tasks: {}
      }
    };
    const saved = { schema: 2, mode: "done", wave: 3, courses: archived,
      order: ["withdrawn", "certified-old"], discovery: true, notes: [] };
    await evaluate("chrome.storage.local.set({state:" + JSON.stringify(saved) + "})");
    await until(() => evaluate("document.getElementById('report').textContent.includes('Previously hidden course')"),
      "restore a historical course absent from the old report order");
    await browser.close();
    browser = await launch(profile);
    assert.equal((await browser.call("Extensions.loadUnpacked", { path: testExtension })).id, id);
    evaluate = await browser.page(dashboard);
    await until(() => evaluate("document.getElementById('start') && document.readyState === 'complete'"), "history after restart");
    await evaluate("document.getElementById('start').click()");
    const completed = await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done" && state.wave === 4 && state;
    }, "catalog refresh after unenrollment");
    for (const [slug, course] of Object.entries(archived)) assert.deepEqual(completed.courses[slug], course);
    assert(!completed.order.includes("withdrawn"));
    assert(!completed.order.includes("hidden-history"));
    assert(completed.order.includes("allpassed"));
    const reportText = await evaluate("document.getElementById('report').textContent");
    for (const text of ["Withdrawn course", "Previously hidden course", "Old certificate", "75%",
      "Saved course reason", "Saved task reason", "Saved file reason", "вне текущей очереди"]) {
      assert(reportText.includes(text), text);
    }
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#report h3 a')].map(a=>new URL(a.href).pathname).sort()"),
      ["/learn/allpassed", "/learn/certified-old", "/learn/hidden-history", "/learn/withdrawn"]);
    assert(!fixture.opens.includes("withdrawn"));
    assert(!fixture.opens.includes("hidden-history"));
    assert.equal(fixture.modelCalls, 0);
    assert.deepEqual(fixture.order, []);
    assert.deepEqual(fixture.errors, []);
    report("PASS all historical courses, grades and reasons survive restart and catalog removal without requeueing withdrawn courses");
  } else if (parallelOnly) {
    fixture.badReply = false;
    const edgeProfile = join(temp, "edge");
    await mkdir(edgeProfile);
    edge = await launch(edgeProfile, process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
    const edgeProduction = await edge.call("Extensions.loadUnpacked", { path: resolve(".") });
    assert.match(edgeProduction.id, /^[a-p]{32}$/);
    const edgeExtension = await edge.call("Extensions.loadUnpacked", { path: testExtension });
    const edgeUi = await edge.page("chrome-extension://" + edgeExtension.id + "/ui/index.html");
    await edge.page(primary.origin + "/");
    const stateFor = ui => ui("chrome.storage.local.get('state').then(result=>result.state)");
    const waitMode = (ui, mode) => until(async () => {
      const state = await stateFor(ui);
      if (state?.mode === "paused" && mode === "done") throw new Error(state.reason);
      return state?.mode === mode && state;
    }, "parallel profile " + mode, 90000);
    const connect = async ui => {
      await until(() => ui("document.getElementById('chat-requests')?.valueAsNumber === 30"), "parallel settings ready");
      await ui("document.getElementById('parallel-enabled').click();document.getElementById('parallel-key').value=" + JSON.stringify(coordinator.key) +
        ";document.getElementById('settings').requestSubmit()");
      const notice = await until(() => ui("document.getElementById('notice').textContent"), "parallel settings response");
      assert.equal(notice, "Настройки сохранены.");
    };
    const unauthenticated = await fetch(coordinator.origin + "/check", { method: "POST" });
    assert.equal(unauthenticated.status, 403);
    await Promise.all([connect(evaluate), connect(edgeUi)]);
    await Promise.all([evaluate("document.getElementById('start').click()"), edgeUi("document.getElementById('start').click()")]);
    await until(() => parallelPrompts.size === 2, "different courses reached both model tabs concurrently", 90000);
    const chromeCourse = (await getState()).parallelCourse.slug;
    const edgeCourse = (await stateFor(edgeUi)).parallelCourse.slug;
    assert.notEqual(chromeCourse, edgeCourse);
    assert.deepEqual(fixture.order, []);
    const key = coordinator.key;
    const port = coordinator.port;
    await browser.close();
    browser = null;
    releaseModels();
    const edgeDone = await waitMode(edgeUi, "done");
    assert.equal(edgeDone.courses[chromeCourse].parallel.ownership, "busy");
    assert.equal(fixture.order.length, 2);
    assert(!fixture.order.includes(parallelCourses[chromeCourse][0]));
    await coordinator.close();
    coordinator = null;
    await edgeUi("document.getElementById('start').click()");
    const unavailable = await waitMode(edgeUi, "paused");
    assert.match(unavailable.reason, /Координатор недоступен/);
    coordinator = await startCoordinator(port);
    assert.equal(coordinator.key, key);
    browser = await launch(profile);
    assert.equal((await browser.call("Extensions.loadUnpacked", { path: testExtension })).id, id);
    evaluate = await browser.page(dashboard);
    await browser.page(primary.origin + "/");
    await waitMode(evaluate, "paused");
    await evaluate("document.getElementById('resume').click()");
    await waitMode(evaluate, "done");
    await edgeUi("document.getElementById('resume').click()");
    const edgeFinal = await waitMode(edgeUi, "done");
    assert.equal(edgeFinal.courses["parallel-third"].parallel, undefined);
    assert.deepEqual(Object.keys(fixture.attempts).sort(), Object.values(parallelCourses).flat().sort());
    assert(Object.values(fixture.attempts).every(count => count === 1));
    assert.deepEqual(fixture.errors, []);
    report("PASS Chrome and Edge work concurrently on different courses, keep ownership across restarts, and submit each assignment once");
  } else if (chatRotationOnly) {
    assert.equal(await evaluate("document.getElementById('chat-requests').valueAsNumber"), 30);
    const modelTabs = JSON.stringify({ url: primary.origin + "/*" });
    await evaluate("chrome.tabs.query(" + modelTabs + ").then(([tab])=>chrome.storage.session.set({" +
      "chatgptUsage:{tabId:tab.id,path:'/',count:29}}))");
    await evaluate("document.getElementById('start').click()");
    await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done";
    }, "rotation between assignments at the default limit", 90000);
    assert.equal(chatRootVisits, 2);
    assert.deepEqual(promptThreads.map(([name]) => name), ["quiz_modal", "quiz_modal", "quiz_direct", "text"]);
    assert.equal(promptThreads[0][1], promptThreads[1][1], "the correction stays in the original chat");
    assert.notEqual(promptThreads[1][1], promptThreads[2][1], "the next assignment starts a fresh chat");
    assert.equal(promptThreads[2][1], promptThreads[3][1], "the next assignment reuses the fresh chat");
    const usage = await evaluate("chrome.storage.session.get('chatgptUsage').then(result=>result.chatgptUsage)");
    assert.equal(usage.count, 2);
    assert.equal(usage.path, "/c/" + promptThreads[2][1]);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "text"]);
    assert.deepEqual(fixture.errors, []);
    report("PASS default 30: correct in the same chat, rotate before the next assignment, and restart the counter");
  } else if (chatRecoveryOnly) {
    fixture.badReply = false;
    const modelTabs = JSON.stringify({ url: primary.origin + "/*" });
    const paths = () => evaluate("chrome.tabs.query(" + modelTabs + ").then(tabs=>tabs.map(tab=>new URL(tab.url).pathname))");
    const useChat = async path => {
      await evaluate("chrome.tabs.query(" + modelTabs + ").then(tabs=>chrome.tabs.remove(tabs.map(tab=>tab.id)))");
      await browser.page(primary.origin + path);
    };
    const single = async key => {
      const target = coursera.origin + taskUrl("quiz-demo", key);
      await evaluate("document.getElementById('single-url').value=" +
        JSON.stringify(target) + ";document.getElementById('single').requestSubmit()");
      return target;
    };
    await single("quiz_modal");
    const paused = await until(async () => {
      const state = await getState();
      return state?.mode === "paused" && state;
    }, "account limit after one fresh chat");
    assert.match(paused.reason, /usage limit/);
    assert.equal(chatRootVisits, 1);
    assert.deepEqual(await paths().then(value => value.sort()), ["/", "/c/account-limited"]);
    assert.deepEqual(quizStages, []);
    assert.equal(fixture.modelCalls, 0);
    rootChatBlocked = false;
    await useChat("/c/full");
    await evaluate("document.getElementById('resume').click()");
    const passed = await until(async () => {
      const state = await getState();
      return state?.mode === "done" && state.single;
    }, "recover a chat that reached the conversation length limit");
    assert.equal(passed.grade, "100%", JSON.stringify(passed));
    assert.equal(chatRootVisits, 2);
    assert.deepEqual(await paths().then(value => value.sort()), ["/", "/c/full"]);
    await useChat("/c/frozen");
    const target = await single("quiz_direct");
    const recovered = await until(async () => {
      const state = await getState();
      return state?.single?.url === target && state.mode === "done" && state.single;
    }, "retry a stalled generation in a fresh tab");
    assert.equal(recovered.grade, "83.33%", JSON.stringify(recovered));
    assert.equal(chatRootVisits, 3);
    assert.equal(frozenSends, 1);
    assert.equal(fixture.modelCalls, 2);
    assert.deepEqual(await paths().then(value => value.sort()), ["/", "/c/frozen"]);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct"]);
    assert.deepEqual(fixture.errors, []);
    report("PASS one fresh tab for persistent account limits, a full conversation, and stalled generation; prior tabs preserved");
  } else if (timedOnly) {
    fixture.badReply = false;
    await evaluate("document.getElementById('start').click()");
    const paused = await until(async () => {
      const state = await getState();
      return state?.mode === "paused" && state;
    }, "pause before starting a timed quiz with no ready model", 45000);
    assert.match(paused.reason, /Перед началом задания.*ChatGPT.*Gemini/);
    assert.deepEqual(quizStages, []);
    assert.equal(fixture.modelCalls, 0);
    for (const key of ["visual_prompt", "visual_option"]) {
      const task = paused.courses["quiz-demo"].tasks["/learn/quiz-demo/quiz/" + key];
      assert.equal(task.status, "skippedVisual", JSON.stringify(task));
      assert.match(task.reason, /визуальный материал/);
    }
    const reserve = await browser.page(gemini.origin + "/");
    await until(() => reserve("!!document.querySelector('rich-textarea [contenteditable]')"), "ready reserve model");
    await evaluate("document.getElementById('resume').click()");
    const complete = await until(async () => {
      const state = await getState();
      if (state?.mode === "paused" && state.reason !== paused.reason) throw new Error(state.reason);
      return state?.mode === "done" && state;
    }, "timed quizzes in the full queue", 90000);
    const tasks = complete.courses["quiz-demo"].tasks;
    assert.equal(tasks["/learn/quiz-demo/quiz/quiz_modal"].grade, "100%");
    assert.equal(tasks["/learn/quiz-demo/assignment-submission/quiz_direct"].grade, "83.33%");
    assert.deepEqual(quizStages, ["start", "confirm-start", "submit", "confirm-submit", "start", "submit", "confirm-submit"]);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "text"]);
    assert.deepEqual(fixture.errors, []);
    report("PASS skips diagrams in fill-in-the-blank questions and in MSQ options, then submits a text-only MSQ");
    report("PASS full queue waits for a ready model before Start and completes both timed quiz variants with the enabled reserve");
  } else if (minimumTimeOnly) {
    fixture.badReply = false;
    await until(() => evaluate("document.getElementById('quiz-delay')?.valueAsNumber === 0"), "zero delay after loading legacy settings");
    for (const quizDelaySeconds of [-1, 1.5, "10"]) {
      const reply = await evaluate("chrome.runtime.sendMessage(" + JSON.stringify({
        action: "settings", settings: { provider: "chatgpt", quizDelaySeconds }
      }) + ")");
      assert.match(reply.error, /число секунд задержки/);
    }
    const setDelay = async seconds => {
      await evaluate("document.getElementById('quiz-delay').value=" + seconds +
        ";document.getElementById('settings').requestSubmit()");
      await until(() => evaluate("chrome.storage.local.get('settings').then(({settings})=>settings.quizDelaySeconds===" + seconds + ")"),
        "persist configured delay");
    };
    await setDelay(12);
    const runQuiz = async key => {
      const target = coursera.origin + taskUrl("quiz-demo", key);
      await evaluate("document.getElementById('single-url').value=" +
        JSON.stringify(target) + ";document.getElementById('single').requestSubmit()");
      return target;
    };
    const finished = target => until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done" && state.single?.url === target && state;
    }, "minimum quiz duration and published result", 100000);
    const target = await runQuiz("quiz_modal");
    const waiting = await until(async () => {
      const state = await getState();
      return state?.current?.stage?.includes("до отправки осталось") && state;
    }, "fast model response waiting for the original deadline");
    const key = "/learn/quiz-demo/quiz/quiz_modal";
    const openedAt = waiting.courses["quiz-demo"].tasks[key].quizTiming.openedAt;
    assert.equal(waiting.courses["quiz-demo"].tasks[key].pending, undefined);
    assert.equal(fixture.attempts.quiz_modal, undefined);
    await evaluate("document.getElementById('pause').click()");
    await until(async () => (await getState())?.mode === "paused", "pause during the minimum duration");
    await delay(5500);
    assert.equal(fixture.attempts.quiz_modal, undefined);
    assert.equal((await getState()).courses["quiz-demo"].tasks[key].quizTiming.openedAt, openedAt);
    assert.deepEqual(await evaluate("chrome.runtime.sendMessage({action:'resume'})"), { ok: true });
    const complete = await finished(target);
    assert.equal(complete.single.grade, "100%");
    assert(quizTiming.quiz_modal.submittedAt >= openedAt + 12000);
    assert(quizTiming.quiz_modal.submittedAt < openedAt + 22000, "resume retains the original deadline");
    assert.equal(complete.courses["quiz-demo"].tasks[key].quizTiming, undefined);
    report("PASS configured 12-second delay persists, and pause/resume retains the original deadline");
    await evaluate("globalThis.minimumStages=[];chrome.storage.onChanged.addListener((changes,area)=>{" +
      "const current=changes.state?.newValue?.current;" +
      "if(area==='local'&&current?.stage)minimumStages.push({stage:current.stage,time:Date.now()});})");
    const slowTarget = await runQuiz("quiz_direct");
    const slowReady = await until(async () => {
      const state = await getState();
      return state?.courses["quiz-demo"].tasks["/learn/quiz-demo/assignment-submission/quiz_direct"]?.quizTiming;
    }, "second quiz opening timestamp");
    const slowComplete = await finished(slowTarget);
    assert.equal(slowComplete.single.grade, "83.33%");
    assert(quizTiming.quiz_direct.responseAt >= slowReady.openedAt + 12000);
    assert(quizTiming.quiz_direct.submittedAt >= quizTiming.quiz_direct.responseAt);
    const stages = await evaluate("globalThis.minimumStages");
    assert(!stages.some(({ stage }) => stage.includes("до отправки осталось")), "a late response never enters the minimum-duration wait");
    const ready = stages.find(({ stage }) => stage === "Заполняю форму Coursera");
    assert(ready, "the model reply was accepted before filling the form");
    assert(quizTiming.quiz_direct.submittedAt - ready.time < 6000, "verification and confirmation add no extra minute");
    await setDelay(0);
    await evaluate("globalThis.minimumStages=[]");
    const zeroTarget = await runQuiz("quiz_zero");
    const zeroComplete = await finished(zeroTarget);
    assert.equal(zeroComplete.single.result, "passed", zeroComplete.single.reason);
    const zeroStages = await evaluate("globalThis.minimumStages");
    assert(!zeroStages.some(({ stage }) => stage.includes("до отправки осталось")), "zero disables the configured delay");
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct", "quiz_zero"]);
    assert.deepEqual(fixture.errors, []);
    report("PASS late response adds no extra wait, zero disables the delay, and invalid delay values are rejected");
  } else if (quizOnly) {
    fixture.badReply = false;
    for (const [quiz, stages, grade] of [
      ["quiz_modal", ["start", "confirm-start", "submit", "confirm-submit"], "100%"],
      ["quiz_direct", ["start", "submit", "confirm-submit"], "83.33%"]
    ]) {
      quizStages.length = 0;
      const processing = new Set();
      const target = coursera.origin + taskUrl("quiz-demo", quiz);
      await evaluate("document.getElementById('single-url').value=" +
        JSON.stringify(target) + ";document.getElementById('single').requestSubmit()");
      const result = await until(async () => {
        const state = await getState();
        if (state?.current?.stage) processing.add(state.current.stage);
        if (state?.mode === "paused") throw new Error(state.reason);
        return state?.single?.url === target && state.mode === "done" && state.single;
      }, quiz + " start and published grade", 90000);
      assert.deepEqual(quizStages, stages, JSON.stringify(result));
      assert.equal(result.grade, grade);
      assert.equal(result.history, "passed");
      assert.equal(result.checked, 1);
      assert((await evaluate("document.getElementById('single-result').textContent")).includes("Оценка " + grade));
      if (quiz === "quiz_direct") {
        assert(processing.has("Coursera отправляет работу"));
        assert(processing.has("Coursera проверяет ответы"));
      }
      report("PASS " + quiz + " → answers → checkbox → Submit → confirm → " + grade + " and attempt history");
    }
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct"]);
    assert.equal(historyVisits, 1);
    assert.equal(historyAssetFinished, false);
    quizStages.length = 0;
    const target = coursera.origin + taskUrl("quiz-demo", "quiz_blocked");
    await evaluate("document.getElementById('single-url').value=" +
      JSON.stringify(target) + ";document.getElementById('single').requestSubmit()");
    const blocked = await until(async () => {
      const state = await getState();
      return state?.single?.url === target && state.mode === "done" && state;
    }, "definite failure before Submit", 45000);
    assert.match(blocked.single.reason, /Submit не нажат.*Кнопка Submit осталась недоступной/);
    assert.equal(blocked.single.result, "manual");
    assert.equal(blocked.courses["quiz-demo"].tasks["/learn/quiz-demo/assignment-submission/quiz_blocked"].pending, undefined);
    assert.deepEqual(quizStages, ["start"]);
    assert.deepEqual(fixture.order, ["quiz_modal", "quiz_direct"]);
    report("PASS alternative quiz layout and transiently disabled Submit, and definite no-click without a pending submission");
    assert.deepEqual(fixture.errors, []);
  } else if (process.argv.includes("--single")) {
    const native = await evaluate("chrome.runtime.sendMessage({action:'native'})");
    assert.deepEqual(native, { ok: true });
    const target = coursera.origin + taskUrl("single", "file_single");
    await evaluate("document.getElementById('single-url').value=" + JSON.stringify(target) +
      ";document.getElementById('single').requestSubmit()");
    await until(async () => {
      const state = await getState();
      if (state?.mode === "paused") throw new Error(state.reason);
      return state?.mode === "done";
    }, "single assignment");
    const result = (await getState()).single;
    assert.equal(result.result, "skippedFiles", JSON.stringify(result));
    assert.match(result.reason, /прикрепления файла/);
    assert.equal(fixture.modelCalls, 0);
    assert.deepEqual(fixture.order, []);
    assert.deepEqual(fixture.errors, []);
    report("PASS single run skips a file field without a model request or submission");
  } else {
  await evaluate("document.getElementById('start').click()");
  const outcome = async () => {
    const current = await getState();
    if (["paused", "done"].includes(current?.mode) && !fixture.attempts.crash) {
      throw new Error("Queue ended early: " + JSON.stringify({ current, fixture }));
    }
    return fixture.attempts.crash;
  };
  await until(outcome, "crash submission", 120000);
  let state = await getState();
  if (state.mode === "paused") throw new Error(state.reason + " / " + JSON.stringify(state.courses));
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.attempts.multi, 1);
  assert.equal(fixture.retryStarts, 0);
  assert.equal(state.courses.first.tasks["/learn/first/quiz/multi"].status, "failed");
  assert.equal(state.courses.first.tasks["/learn/first/quiz/multi"].grade, "60%");
  assert.equal(fixture.attempts.text, 1);
  for (const [key, reason] of Object.entries({
    file: /прикрепления файла/, file_source: /Cooja_task\.pdf/,
    file_instructions: /скачать файл/, file_upload_instruction: /прикрепить файл/, file_materials: /Cooja_task\.pdf/
  })) {
    const task = state.courses.first.tasks["/learn/first/" + statusSlug(key) + "/" + key];
    assert.equal(task.status, "skippedFiles", JSON.stringify(task));
    assert.match(task.reason, reason);
    assert.equal(fixture.attempts[key], undefined);
  }
  assert.equal(fixture.fileStarts, 0);
  assert.equal(fixture.materialRequests, 0);
  assert.deepEqual(fixture.materialUploads, []);
  assert.deepEqual(state.courses.first.reviews, [
    { title: "Review 3 peers' assignments.", url: "/learn/first/home/assignments" }
  ]);
  assert.deepEqual(await evaluate("chrome.downloads.search({})"), []);
  assert(fixture.confirmed.includes("peer"));
  assert.equal(fixture.attempts.peer, 1);
  assert.equal(fixture.opens.includes("certified"), false);
  assert.equal(state.courses.certified.status, "certificate");
  assert.equal(state.courses.first.tasks["/learn/first/peer/peer"].status, "peer");
  assert.equal(state.courses.first.tasks["/learn/first/quiz/text"].status, "submitted");
  assert(state.courses.second.tasks["/learn/second/quiz/crash"].pending);
  report("PASS pagination, Show more, deduplication and skip certified course");
  report("PASS file fields, PDF links and download instructions are skipped before model, download or submit");
  report("PASS required form checkbox for quiz/text, peer confirmation dialog and queue continuation");
  report("PASS score below the threshold is recorded without retaking the quiz");
  await browser.close();
  browser = await launch(profile);
  const reopened = await browser.call("Extensions.loadUnpacked", { path: testExtension });
  assert.equal(reopened.id, id, "the same unpacked directory must retain its extension ID");
  await browser.page(primary.origin + "/limited");
  await browser.page(gemini.origin + "/");
  evaluate = await browser.page(dashboard);
  await until(() => evaluate("!!document.getElementById('resume') && !!globalThis.chrome?.storage?.local"),
    "dashboard after Chrome restart");
  await until(async () => (await getState())?.mode === "paused", "Chrome startup recovery");
  await evaluate("document.getElementById('resume').click()");
  await until(async () => (await getState())?.mode === "done", "recovered queue", 90000);
  state = await getState();
  assert.equal(state.courses.second.tasks["/learn/second/quiz/crash"].status, "passed");
  assert.equal(state.courses.second.tasks["/learn/second/quiz/uncertain"].status, "uncertain");
  assert.equal(fixture.attempts.crash, 1);
  assert.equal(fixture.attempts.uncertain, 1);
  assert(state.notes.some(note => note.includes("ChatGPT")));
  report("PASS real Chrome shutdown just after Submit, reconcile without duplicate submission");
  fixture.mode = "graded";
  const passedVisits = fixture.opens.filter(slug => slug === "allpassed").length;
  assert(passedVisits > 0);
  await evaluate("document.getElementById('start').click()");
  await until(async () => {
    const state = await getState();
    return state?.wave === 2 && state.mode === "done";
  }, "next scan", 90000);
  state = await getState();
  assert.equal(state.courses.first.tasks["/learn/first/peer/peer"].status, "passed");
  assert.equal(fixture.attempts.uncertain, 1);
  assert.equal(fixture.attempts.peer, 1);
  assert.equal(fixture.attempts.multi, 1);
  assert.equal(fixture.retryStarts, 0);
  assert.equal(fixture.opens.filter(slug => slug === "allpassed").length, passedVisits);
  assert.equal(state.courses.allpassed.status, "awaitingCertificate");
  assert(state.order.includes("allpassed"));
  assert.deepEqual(fixture.errors, []);
  report("PASS recheck peer grade, skip passed courses on Start and keep unconfirmed submission for manual follow-up");
  }
} finally {
  releaseModels();
  if (edge) await edge.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (coordinator) await coordinator.close().catch(() => {});
  const uninstaller = spawn("reg.exe", ["DELETE", registry, "/f"], { windowsHide: true, stdio: "ignore" });
  await once(uninstaller, "exit");
  for (const { server } of [coursera, primary, gemini]) server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
}
