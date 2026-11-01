/**
 * 端到端（真实 daemon 进程）：定时任务入队时，登记在任务会话里的「供应商 + 模型」。
 *
 * 任务自己选了供应商后，daemon 有两条入队路径都要认它，否则界面上选了、跑起来还是通道的那一家：
 * - 手动触发（Electron 经 /enqueue 入队，body 里带 model / modelParams / resourceId）；
 * - cron 触发（daemon 自己读任务文件，走 enqueueScheduledTaskMessage）。
 *
 * 测试通道（隔离 daemon 里的 ch_test）没有配供应商，所以「任务没选供应商」时登记里不会有 resourceId。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configDir } from "../../src/shared/data-paths"
import { getSessionRecord, initSessionOverridesStore, resetSessionOverridesStoreForTests } from "../../src/shared/session-overrides-store"
import { startIsolatedDaemon, waitFor, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon()
  initSessionOverridesStore(d.dataDir)
})
afterEach(async () => {
  resetSessionOverridesStoreForTests()
  await d?.stop()
})

const enqueue = (taskId: string, extra: Record<string, unknown>) =>
  d.post("/enqueue", { content: "[定时任务: t] x", sessionKey: taskId, chatType: "task", channelId: "ch_test", ...extra })

describe("手动触发：/enqueue 登记的供应商", () => {
  it("带了供应商：登记任务选的这一家，模型和参数照存", async () => {
    const id = "task-manual-own"
    expect((await enqueue(id, { model: "gpt-5", modelParams: "[1]", resourceId: "llm_own" })).ok).toBe(true)
    expect(getSessionRecord(id)).toMatchObject({ model: "gpt-5", modelParams: "[1]", resourceId: "llm_own" })
  })

  it("没带供应商：不登记 resourceId（通道也没配），模型照存", async () => {
    const id = "task-manual-follow-provider"
    await enqueue(id, { model: "composer-2" })
    const rec = getSessionRecord(id)
    expect(rec?.model).toBe("composer-2")
    expect(rec?.resourceId).toBeUndefined()
  })

  it("没配模型：什么都不登记，哪怕带了供应商（供应商只在同时有模型时生效）", async () => {
    const id = "task-manual-no-model"
    expect((await enqueue(id, { resourceId: "llm_own" })).ok).toBe(true)
    expect(getSessionRecord(id)?.model).toBeUndefined()
    expect(getSessionRecord(id)?.resourceId).toBeUndefined()
  })
})

describe("cron 触发：daemon 读任务文件入队登记的供应商", () => {
  /** 每秒触发一次的任务；daemon 监听任务文件，改动后 0.5 秒内重载并立刻补扫最近几秒的触发点 */
  const writeTasks = (tasks: Record<string, unknown>[]) => {
    const dir = configDir(d.dataDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "scheduled-tasks.json"), JSON.stringify(tasks))
  }
  const task = (id: string, extra: Record<string, unknown>) => ({
    id, name: id, cron: "* * * * * *", content: "x", enabled: true, independent: true, channelId: "ch_test", ...extra,
  })

  it("任务选了供应商：登记的是任务的；没选：不带供应商；没配模型：不登记", async () => {
    writeTasks([
      task("task-cron-own", { model: "gpt-5", modelParams: "[1]", resourceId: "llm_own" }),
      task("task-cron-follow", { model: "composer-2" }),
      task("task-cron-no-model", { resourceId: "llm_own" }),
    ])

    expect(await waitFor(() => !!getSessionRecord("task-cron-own") && !!getSessionRecord("task-cron-follow"), 20000, 250)).toBe(true)

    expect(getSessionRecord("task-cron-own")).toMatchObject({ model: "gpt-5", modelParams: "[1]", resourceId: "llm_own" })
    const follow = getSessionRecord("task-cron-follow")
    expect(follow?.model).toBe("composer-2")
    expect(follow?.resourceId).toBeUndefined()
    // 三个任务在同一轮里入队，前两个都已登记，说明第三个也已经被处理过了
    expect(getSessionRecord("task-cron-no-model")?.model).toBeUndefined()
    expect(getSessionRecord("task-cron-no-model")?.resourceId).toBeUndefined()
  })
})
