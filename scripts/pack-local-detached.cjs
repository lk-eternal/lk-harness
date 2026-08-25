#!/usr/bin/env node
/**
 * Detach pack-local.ps1 so killing LK Harness does not kill the pack job.
 * Usage: node scripts/pack-local-detached.cjs
 *        npm run pack:local
 *
 * 用 Start-Process 拉起独立 PowerShell 树；勿用 spawn+unref（父进程结束会掐掉子进程，日志 0 字节）。
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const ps1 = path.join(root, "scripts", "pack-local.ps1");
const logDir = path.join(root, "temp");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const markerLog = path.join(logDir, `pack-local-detached-${stamp}.log`);

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
  `[${new Date().toISOString()}] Start-Process pack-local.ps1 pid=${pid}`,
  `ps1=${ps1}`,
  `root=${root}`,
  r.stderr ? `stderr=${r.stderr.trim()}` : "",
].filter(Boolean);
fs.writeFileSync(markerLog, lines.join("\n") + "\n", "utf8");

if (r.status !== 0) {
  console.error("pack-local detached failed:", r.stderr || r.status);
  process.exit(r.status || 1);
}

console.log(`pack-local detached pid=${pid}`);
console.log(`marker: ${markerLog}`);
console.log("进度见 temp/pack-local-YYYYMMDD-HHmmss.log；完成后自动重启 release\\local");
