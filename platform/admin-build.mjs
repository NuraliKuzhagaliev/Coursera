import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
if (existsSync(".env")) process.loadEnvFile(".env");
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build", "platform/admin"],
  { stdio: "inherit", windowsHide: true });
process.exitCode = (await once(child, "exit"))[0] ?? 1;
