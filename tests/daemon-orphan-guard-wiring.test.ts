import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 「机器人自己说话」的防护有没有真的接到 daemon 里（模块本身的行为由各自的单测锁住）：
 * - daemonMain 最先装管道防护，且收到 LK_HARNESS_PARENT_PID 就起父进程看门狗；
 * - 删锁文件只删自己的；
 * - 应用启动 daemon 时把自己的 pid 交过去；
 * - 队列丢弃重复投递时有日志。
 */

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n")
const daemonSrc = read("src", "daemon.ts")
const managerSrc = read("electron", "daemon-manager.ts")

function bodyOf(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker)
  expect(start, `找不到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf("\n}\n", start)
  expect(end, `${startMarker} 没有结尾`).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe("daemonMain 接线", () => {
  const body = bodyOf(daemonSrc, "export async function daemonMain()")

  it("最先装 guardBrokenPipe（在第一条 log 之前），同时保护 stdout 和 stderr", () => {
    const guard = body.indexOf("guardBrokenPipe([process.stdout, process.stderr])")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf("log("))
  })

  it("读 LK_HARNESS_PARENT_PID 起看门狗，父进程没了走和 SIGTERM 一样的 cleanup", () => {
    expect(body).toMatch(/parsePidEnv\(process\.env\.LK_HARNESS_PARENT_PID\)/)
    const watchdog = body.slice(body.indexOf("startParentWatchdog("))
    expect(watchdog).toMatch(/onOrphaned:[\s\S]*?cleanup\(\)/)
    expect(body).toMatch(/process\.on\("SIGTERM", cleanup\)/)
  })

  it("没有 LK_HARNESS_PARENT_PID（独立运行 / e2e）时不起看门狗", () => {
    expect(body).toMatch(/if \(parentPid\) \{\s*startParentWatchdog\(/)
  })
})

describe("锁文件", () => {
  it("removeLockFile 只删自己的：走 removeLockFileIfOwned，传自己的 pid，不再无条件 unlink", () => {
    const body = bodyOf(daemonSrc, "function removeLockFile()")
    expect(body).toContain("removeLockFileIfOwned(getLockFilePath(), process.pid)")
    expect(body).not.toContain("unlinkSync")
  })
})

describe("应用启动 daemon", () => {
  it("把自己的 pid 放进 daemon 的环境变量，且在 spawn 之前", () => {
    const envAt = managerSrc.indexOf("LK_HARNESS_PARENT_PID: String(process.pid)")
    expect(envAt).toBeGreaterThan(-1)
    const spawnAt = managerSrc.indexOf("daemonProcess = spawn(process.execPath, [entryPath]")
    expect(spawnAt).toBeGreaterThan(envAt)
    // pid 所在的那份 env，正是 spawn 传下去的那份
    const literalStart = managerSrc.lastIndexOf("const env: Record<string, string> = {", envAt)
    expect(literalStart, "pid 不在传给 daemon 的 env 对象字面量里").toBeGreaterThan(-1)
    expect(managerSrc.slice(literalStart, envAt)).not.toContain("}")
    expect(managerSrc.slice(spawnAt, spawnAt + 300)).toMatch(/env: \{ \.\.\.env, ELECTRON_RUN_AS_NODE: "1" \}/)
  })
})

describe("队列重复投递的日志", () => {
  it("initQueue 里注册了丢弃回调，并打 WARN", () => {
    const body = bodyOf(daemonSrc, "function initQueue()")
    expect(body).toMatch(/setDuplicateDropLogger\(\(id\) => log\("WARN"/)
  })

  it("pushMessage 对「此前已处理过」的跳过单独说明，不和写入失败混在一起", () => {
    const body = bodyOf(daemonSrc, "function pushMessage(")
    expect(body).toContain("isMessageHandled(messageId)")
    expect(body).toContain("此前已处理过")
  })
})
