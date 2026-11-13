import { build } from "esbuild";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
const out = resolve("dist/extension");
const api = process.env.BUILD_API_ORIGIN;
await mkdir("platform/build", { recursive: true });
await build({ entryPoints: ["platform/server/index.ts"], outfile: "platform/build/server.mjs",
  bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", sourcemap: false });
if (process.argv.includes("--server-only")) process.exit(0);
if (!api || !/^https:\/\//.test(api) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(api)) {
  throw new Error("Set BUILD_API_ORIGIN to the Render HTTPS API origin.");
}
await mkdir(out, { recursive: true });
let worker = await readFile("src/worker.js", "utf8");
const replace = (from, to) => {
  if (!worker.includes(from)) throw new Error("Worker integration point changed: " + from);
  worker = worker.replace(from, to);
};
replace('import { Manual, Hold, parseAnswer, makePrompt, confirmedResult, resultForCourse } from "./core.js";',
  'import { Manual, Hold, confirmedResult } from "./core.js";\n' +
  'import { requireLicense, authorizeMutation, protectedPrompt, protectedAnswer, protectedCourse, handleAuthMessage, monitorLicense } from "../platform/extension/license.ts";');
replace('  const options = { target: { tabId: tab }, injectImmediately };',
  '  if (filename === "coursera.js" && ["open","confirm-start","fill","submit"].includes(args[0])) await authorizeMutation(args[0]);\n' +
  '  else await requireLicense();\n  const options = { target: { tabId: tab }, injectImmediately };');
replace('const { requestId, raw } = await withChatRecovery', 'const { requestId, raw, job } = await withChatRecovery');
replace('const data = { id: requestId, prompt: makePrompt(assessment, requestId, feedback, correction) };',
  'const { prompt, job } = await protectedPrompt(assessment, requestId, feedback || "", correction);\n' +
  '          const data = { id: requestId, prompt };');
replace('return { requestId, raw: await waitForReply(id, provider, requestId) };',
  'return { requestId, raw: await waitForReply(id, provider, requestId), job };');
replace('return parseAnswer(raw, requestId, assessment);', 'return await protectedAnswer(raw, requestId, assessment, job);');
replace('course.status = resultForCourse(course);', 'course.status = await protectedCourse(course);');
replace('    await load();\n    if (message.action === "native")',
  '    await load();\n' +
  '    if (message.action?.startsWith("auth.")) {\n' +
  '      if (message.action === "auth.logout" && state.mode === "running") { state.mode = "paused"; state.reason = "Выход из аккаунта."; await save(); }\n' +
  '      return handleAuthMessage(message);\n    }\n' +
  '    if (["start","resume","single"].includes(message.action)) await requireLicense(true);\n' +
  '    if (message.action === "native")');
worker += '\nmonitorLicense(async error => { await load(); if (state.mode === "running") { state.mode="paused"; state.reason=error.message; await save(); } });\n';
const bundle = { bundle: true, format: "esm", target: "chrome120", minify: true, sourcemap: false, legalComments: "none" };
await build({ ...bundle, stdin: { contents: worker, resolveDir: resolve("src"), loader: "js" },
  outfile: out + "/src/worker.js", define: { __API_ORIGIN__: JSON.stringify(new URL(api).origin) } });
for (const file of ["coursera", "providers"]) await build({
  ...bundle, format: "iife", entryPoints: ["src/" + file + ".js"], outfile: out + "/src/" + file + ".js"
});
await cp("ui", out + "/ui", { recursive: true });
await build({ ...bundle, entryPoints: ["platform/extension/index.tsx"], outfile: out + "/ui/account.js" });
let html = await readFile("ui/index.html", "utf8");
html = html.replace('<script type="module" src="index.js"></script>',
  '<script type="module" src="index.js"></script>\n  <script type="module" src="account.js"></script>');
html = html.replace("<main>", '<main>\n    <div id="license-root"></div>');
await writeFile(out + "/ui/index.html", html);
await build({ ...bundle, entryPoints: ["ui/index.js"], outfile: out + "/ui/index.js" });
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.version = "2.0.0";
manifest.name = "Coursera Queue";
manifest.host_permissions.push(new URL(api).origin + "/*", "https://coursera.org/*");
if (!process.env.SUPABASE_URL) throw new Error("Set SUPABASE_URL for the extension's Auth permission.");
manifest.host_permissions.push(new URL(process.env.SUPABASE_URL).origin + "/*");
await writeFile(out + "/manifest.json", JSON.stringify(manifest, null, 2));
await mkdir(out + "/helper", { recursive: true });
await cp("helper/coordinator.py", out + "/helper/coordinator.py");
const built = await readFile(out + "/src/worker.js", "utf8");
if (built.includes("Верни один объект JSON") || built.includes("zipEntries")) {
  throw new Error("Private engine code leaked into the browser bundle.");
}
console.log("Built the licensed extension in dist/extension and the separate server in platform/build.");
