import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  readScheduledTasksFile,
  writeScheduledTasksFile,
  findScheduledTaskBySessionKey,
  formatScheduledTaskLabel,
  buildNotifySessionKey,
  isIndependentTaskSessionKey,
  scheduledTaskNotifyPromptLines,
  type ScheduledTask,
} from "../src/shared/scheduled-task.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-task-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "任务",
    cron: "0 9 * * *",
    content: "做点事",
    enabled: true,
    ...overrides,
  }
}

describe("readScheduledTasksFile", () => {
  it("文件不存在返回空数组", () => {
    expect(readScheduledTasksFile(path.join(dir, "none.json"))).toEqual([])
  })

  it("损坏 JSON 返回空数组", () => {
    const file = path.join(dir, "bad.json")
    fs.writeFileSync(file, "{not json", "utf-8")
    expect(readScheduledTasksFile(file)).toEqual([])
  })

  it("顶层非数组返回空数组", () => {
    const file = path.join(dir, "obj.json")
    fs.writeFileSync(file, JSON.stringify({ id: "x" }), "utf-8")
    expect(readScheduledTasksFile(file)).toEqual([])
  })

  it("过滤缺少必填字段的项", () => {
    const file = path.join(dir, "mixed.json")
    fs.writeFileSync(file, JSON.stringify([
      makeTask(),
      { id: "no-name", cron: "* * * * *", content: "x" },
      "not-an-object",
      null,
    ]), "utf-8")
    const tasks = readScheduledTasksFile(file)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("t1")
  })

  it("enabled 缺省归一化为 true，显式 false 保留", () => {
    const file = path.join(dir, "enabled.json")
    const noEnabled = { id: "a", name: "n", cron: "* * * * *", content: "c" }
    fs.writeFileSync(file, JSON.stringify([noEnabled, makeTask({ id: "b", enabled: false })]), "utf-8")
    const tasks = readScheduledTasksFile(file)
    expect(tasks.find((t) => t.id === "a")?.enabled).toBe(true)
    expect(tasks.find((t) => t.id === "b")?.enabled).toBe(false)
  })
})

describe("writeScheduledTasksFile", () => {
  it("自动创建父目录并可往返读取", () => {
    const file = path.join(dir, "nested", "deep", "tasks.json")
    const tasks = [makeTask(), makeTask({ id: "t2", channelId: "ch_x", model: "composer-2" })]
    writeScheduledTasksFile(file, tasks)
    expect(readScheduledTasksFile(file)).toEqual(tasks)
  })
})

describe("findScheduledTaskBySessionKey", () => {
  it("匹配裸 task.id，忽略带 chatKey/workspace 的 sessionKey", () => {
    const tasks = [makeTask({ id: "t1", name: "日报" }), makeTask({ id: "t2", name: "周报" })]
    expect(findScheduledTaskBySessionKey("t1", tasks)?.name).toBe("日报")
    expect(findScheduledTaskBySessionKey("ch_a|oc_1", tasks)).toBeUndefined()
    expect(findScheduledTaskBySessionKey("t1::D:\\ws", tasks)).toBeUndefined()
  })
})

describe("formatScheduledTaskLabel", () => {
  it("加定时任务前缀", () => {
    expect(formatScheduledTaskLabel("英文合班入班追踪")).toBe("⏰ 英文合班入班追踪")
  })
})

describe("buildNotifySessionKey", () => {
  it("用 channelId + 裸群 id 拼 chatKey", () => {
    expect(buildNotifySessionKey({ channelId: "ch_a", notifyChatId: "oc_group1" })).toBe("ch_a|oc_group1")
  })

  it("已是完整 chatKey 则原样返回", () => {
    expect(buildNotifySessionKey({ channelId: "ch_a", notifyChatId: "ch_b|oc_x" })).toBe("ch_b|oc_x")
  })

  it("缺 notifyChatId 或 channelId 返回 undefined", () => {
    expect(buildNotifySessionKey({ channelId: "ch_a" })).toBeUndefined()
    expect(buildNotifySessionKey({ notifyChatId: "oc_x" })).toBeUndefined()
  })
})

describe("isIndependentTaskSessionKey", () => {
  const tasks = [
    makeTask({ id: "indep-1", independent: true }),
    makeTask({ id: "non-indep", independent: false }),
    makeTask({ id: "default-indep" }),
  ]

  it("独立任务 id 命中", () => {
    expect(isIndependentTaskSessionKey("indep-1", tasks)).toBe(true)
    expect(isIndependentTaskSessionKey("default-indep", tasks)).toBe(true)
  })

  it("非独立或非法 sessionKey 不命中", () => {
    expect(isIndependentTaskSessionKey("non-indep", tasks)).toBe(false)
    expect(isIndependentTaskSessionKey("ch_a|oc_x", tasks)).toBe(false)
    expect(isIndependentTaskSessionKey("ch_a|oc_x::/tmp", tasks)).toBe(false)
    expect(isIndependentTaskSessionKey("unknown", tasks)).toBe(false)
  })
})

describe("scheduledTaskNotifyPromptLines", () => {
  it("包含 notify_session_key 与投递规则", () => {
    const lines = scheduledTaskNotifyPromptLines("ch_a|oc_g")
    expect(lines[0]).toBe("[notify_session_key=ch_a|oc_g]")
    expect(lines.some((l) => l.includes("必须且只能"))).toBe(true)
  })
})
