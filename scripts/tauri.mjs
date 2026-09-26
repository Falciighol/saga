// Runs the Tauri CLI, putting the actool wrapper in scripts/macos first on PATH on macOS.
import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
if (process.platform === "darwin") env.PATH = join(here, "macos") + delimiter + env.PATH;

const child = spawn("tauri", process.argv.slice(2), { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
