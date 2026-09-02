#!/usr/bin/env node
/**
 * Detach dev-restart.ps1 so killing LK Harness does not kill the restart job.
 * Usage: node scripts/dev-restart-detached.cjs
 *        npm run dev:restart
 *
 * 用 Start-Process 拉起独立 PowerShell 树；勿用 spawn+unref（父进程结束会掐掉子进程）。
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const ps1 = path.join(root, "scripts", "dev-restart.ps1");
const logDir = path.join(root, "temp");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const markerLog = path.join(logDir, `dev-restart-detached-${stamp}.log`);

const ps1Esc = ps1.replace(/'/g, "''");
const rootEsc = root.replace(/'/g, "''");
const cmd = [
  "Start-Process",
  "-FilePath", "powershell.exe",
  "-ArgumentList", "'-NoProfile','-ExecutionPolicy','Bypass','-File','" + ps1Esc + "'",
  "-WorkingDirectory", "'" + rootEsc + "'",
  "-WindowStyle", "Hidden",
  "-PassThru",
].join(" ");

const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
  { cwd: root, encoding: "utf8", windowsHide: true },
);

const pid = (r.stdout || "").trim().split(/\s+/).pop() || "?";
const lines = [
  `[${new Date().toISOString()}] Start-Process dev-restart.ps1 pid=${pid}`,
  `ps1=${ps1}`,
  `root=${root}`,
  r.stderr ? `stderr=${r.stderr.trim()}` : "",
].filter(Boolean);
fs.writeFileSync(markerLog, lines.join("\n") + "\n", "utf8");

if (r.status !== 0) {
  console.error("dev-restart detached failed:", r.stderr || r.status);
  process.exit(r.status || 1);
}

console.log(`dev-restart detached pid=${pid}`);
console.log(`marker: ${markerLog}`);
console.log("进度见 temp/dev-restart-YYYYMMDD-HHmmss.log");
