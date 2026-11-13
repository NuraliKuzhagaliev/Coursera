import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
const temp = await mkdtemp(join(tmpdir(), "coursera-licensed-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, name) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { const result = await read(); if (result) return result; }
    catch (error) { if (!/execution context|context.*destroyed/i.test(error.message)) throw error; }
    await delay(100);
  }
  throw new Error("Timeout " + name);
}
const server = createServer((request, response) => {
  if (request.url === "/v1/config") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ supabaseUrl: "https://example.invalid", publishableKey: "fixture-public-key",
      adminOrigin: "https://example.invalid", plans: [] }));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<label for="name">Full name</label><input id="name" aria-label="Full name" value="Fixture Learner">' +
      '<label for="email">Email address</label><input id="email" type="email" value="learner@example.test">' +
      '<input type="password" value="never-read"><button>Save Changes</button>');
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const compile = spawn(process.execPath, ["platform/build.mjs"], { windowsHide: true, stdio: "inherit",
  env: { ...process.env, BUILD_API_ORIGIN: "http://127.0.0.1:" + port, BUILD_EXTENSION_DIR: join(temp, "extension") } });
assert.equal((await once(compile, "exit"))[0], 0);
let chrome, socket;
try {
  chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless", "--disable-gpu", "--no-first-run", "--no-proxy-server",
    "--disable-background-networking", "--enable-unsafe-extension-debugging",
    "--host-resolver-rules=MAP www.coursera.org 127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + join(temp, "profile"), "about:blank"
  ], { windowsHide: true, stdio: "ignore" });
  const debugPort = await until(async () => (await readFile(join(temp, "profile", "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0], "DevTools");
  const info = await (await fetch("http://127.0.0.1:" + debugPort + "/json/version")).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await once(socket, "open");
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const page = async url => {
    const { targetId } = await cdp("Target.createTarget", { url });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId, async evaluate(expression) {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } };
  };
  const { id } = await cdp("Extensions.loadUnpacked", { path: join(temp, "extension") });
  const dashboard = await page("chrome-extension://" + id + "/ui/index.html");
  await until(() => dashboard.evaluate("document.body?.textContent.includes('Регистрация')"), "React account panel");
  await dashboard.evaluate("chrome.storage.local.set({license:{active:true,role:'admin'}})");
  const start = await dashboard.evaluate("chrome.runtime.sendMessage({action:'start'})");
  assert.match(start.error, /Войдите в аккаунт/);
  const state = await dashboard.evaluate("chrome.storage.local.get('state').then(({state})=>state)");
  assert.equal(state, undefined);
  const source = await build({ entryPoints: ["platform/extension/identity.ts"], bundle: true, format: "iife",
    globalName: "IdentityFixture", target: "chrome120", write: false });
  const account = await page("http://127.0.0.1:" + port + "/account-settings");
  await until(() => account.evaluate("!!document.querySelector('#email')"), "Coursera identity fixture");
  const fixtureSource = source.outputFiles[0].text.replace(/"www\.coursera\.org",\s*"coursera\.org"/, '"127.0.0.1"');
  assert.notEqual(fixtureSource, source.outputFiles[0].text, "map only the test origin");
  await account.evaluate(fixtureSource);
  assert.deepEqual(await account.evaluate("IdentityFixture.readIdentityFields()"), { name: "Fixture Learner", email: "learner@example.test" });
  await account.evaluate("document.body.insertAdjacentHTML('beforeend','<input type=email value=other@example.test>')");
  assert.equal(await account.evaluate("IdentityFixture.readIdentityFields()"), null);
  const capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, dashboard.sessionId);
  await writeFile(resolve("platform/build/account-preview.png"), Buffer.from(capture.data, "base64"));
  console.log("PASS packaged MV3 React UI, forged local license denied, account name/email labels and ambiguous email fail-closed");
  await cdp("Browser.close");
} finally {
  socket?.close();
  chrome?.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
}
