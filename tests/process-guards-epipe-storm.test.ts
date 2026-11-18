import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { buildSync } from "esbuild"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/**
 * 真进程复现「机器人自己说话」的一条根因：
 * 应用没了以后，daemon 的 stderr 另一头已经关了。每写一行日志都 EPIPE；
 * 没有 error 监听 → uncaughtException → 处理器又往 stderr 写一行 → 再 EPIPE → ……
 * 事件循环被占满，飞书事件不再应答，飞书便把事件反复重推。
 *
 * 子进程里的 uncaughtException 处理器和 daemon 的一样：往 stderr 写一行日志。
 * 父进程在子进程就绪后把读端关掉（等于应用退出），再让子进程写第一行日志，数 800 毫秒内触发了多少次。
 */

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-epipe-"))
  const bundled = buildSync({
    entryPoints: [path.resolve(__dirname, "..", "src", "shared", "process-guards.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  })
  fs.writeFileSync(path.join(dir, "guards.cjs"), bundled.outputFiles[0].text)
  fs.writeFileSync(path.join(dir, "child.cjs"), `
const fs = require("node:fs");
const { guardBrokenPipe } = require("./guards.cjs");
if (process.env.GUARD === "1") guardBrokenPipe([process.stdout, process.stderr]);
let n = 0;
process.on("uncaughtException", (e) => { n++; process.stderr.write("未捕获异常: " + (e && e.code) + "\\n"); });
fs.writeFileSync(process.env.READY_FILE, "1");
const t = setInterval(() => {
  if (!fs.existsSync(process.env.GO_FILE)) return;
  clearInterval(t);
  process.stderr.write("第一行日志\\n");
  setTimeout(() => { fs.writeFileSync(process.env.RESULT_FILE, String(n)); process.exit(0); }, 800);
}, 10);
`)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 返回子进程在管道断开后的 800 毫秒里，uncaughtException 被触发的次数 */
function uncaughtExceptionsAfterPipeClosed(guard: boolean): Promise<number> {
  const tag = guard ? "guard" : "noguard"
  const files = {
    READY_FILE: path.join(dir, `${tag}.ready`),
    GO_FILE: path.join(dir, `${tag}.go`),
    RESULT_FILE: path.join(dir, `${tag}.result`),
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, "child.cjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GUARD: guard ? "1" : "0", ...files },
    })
    const watch = setInterval(() => {
      if (!fs.existsSync(files.READY_FILE)) return
      clearInterval(watch)
      child.stderr!.destroy()
      child.stdout!.destroy()
      fs.writeFileSync(files.GO_FILE, "1")
    }, 10)
    const giveUp = setTimeout(() => {
      clearInterval(watch)
      child.kill()
      reject(new Error(`${tag} 子进程 8 秒内没有结束`))
    }, 8000)
    child.on("exit", () => {
      clearTimeout(giveUp)
      clearInterval(watch)
      try {
        resolve(Number(fs.readFileSync(files.RESULT_FILE, "utf-8")))
      } catch (e) {
        reject(e)
      }
    })
  })
}

describe("daemon 的 stderr 另一头没了以后（真进程）", () => {
  it("没有防护：uncaughtException 自己喂自己，一路刷屏", async () => {
    expect(await uncaughtExceptionsAfterPipeClosed(false)).toBeGreaterThan(100)
  }, 20_000)

  it("装了 guardBrokenPipe：一次都不触发，进程正常结束", async () => {
    expect(await uncaughtExceptionsAfterPipeClosed(true)).toBe(0)
  }, 20_000)
})
