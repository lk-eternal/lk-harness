import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  readScheduledTasksFile,
  writeScheduledTasksFile,
  ScheduledTasksReadError,
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
    name: "task",
    cron: "0 9 * * *",
    content: "do something",
    enabled: true,
    ...overrides,
  }
}

describe("readScheduledTasksFile", () => {
  it("missing file returns empty array", () => {
    expect(readScheduledTasksFile(path.join(dir, "none.json"))).toEqual([])
  })

  it("corrupt JSON throws ScheduledTasksReadError", () => {
    const file = path.join(dir, "bad.json")
    fs.writeFileSync(file, "{not json", "utf-8")
    expect(() => readScheduledTasksFile(file)).toThrow(ScheduledTasksReadError)
    expect(fs.readdirSync(dir).some((f) => f.startsWith("bad.json.corrupt-"))).toBe(true)
  })

  it("non-array top-level returns empty array", () => {
    const file = path.join(dir, "obj.json")
    fs.writeFileSync(file, JSON.stringify({ id: "x" }), "utf-8")
    expect(readScheduledTasksFile(file)).toEqual([])
  })

  it("filters invalid entries", () => {
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

  it("enabled defaults to true", () => {
    const file = path.join(dir, "enabled.json")
    const noEnabled = { id: "a", name: "n", cron: "* * * * *", content: "c" }
    fs.writeFileSync(file, JSON.stringify([noEnabled, makeTask({ id: "b", enabled: false })]), "utf-8")
    const tasks = readScheduledTasksFile(file)
    expect(tasks.find((t) => t.id === "a")?.enabled).toBe(true)
    expect(tasks.find((t) => t.id === "b")?.enabled).toBe(false)
  })
})

describe("writeScheduledTasksFile", () => {
  it("creates parent dir and roundtrips", () => {
    const file = path.join(dir, "nested", "deep", "tasks.json")
    const tasks = [makeTask(), makeTask({ id: "t2", channelId: "ch_x", model: "composer-2" })]
    writeScheduledTasksFile(file, tasks)
    expect(readScheduledTasksFile(file)).toEqual(tasks)
  })
})

describe("findScheduledTaskBySessionKey", () => {
  it("matches bare task id only", () => {
    const tasks = [makeTask({ id: "t1", name: "daily" }), makeTask({ id: "t2", name: "weekly" })]
    expect(findScheduledTaskBySessionKey("t1", tasks)?.name).toBe("daily")
    expect(findScheduledTaskBySessionKey("ch_a|oc_1", tasks)).toBeUndefined()
    expect(findScheduledTaskBySessionKey("t1::D:\\ws", tasks)).toBeUndefined()
  })
})

describe("formatScheduledTaskLabel", () => {
  it("adds timer prefix", () => {
    expect(formatScheduledTaskLabel("demo")).toBe("\u23F0 demo")
  })
})

describe("buildNotifySessionKey", () => {
  it("builds chatKey from channelId and notifyChatId", () => {
    expect(buildNotifySessionKey({ channelId: "ch_a", notifyChatId: "oc_group1" })).toBe("ch_a|oc_group1")
  })

  it("returns full chatKey as-is", () => {
    expect(buildNotifySessionKey({ channelId: "ch_a", notifyChatId: "ch_b|oc_x" })).toBe("ch_b|oc_x")
  })

  it("returns undefined when missing parts", () => {
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

  it("matches independent task ids", () => {
    expect(isIndependentTaskSessionKey("indep-1", tasks)).toBe(true)
    expect(isIndependentTaskSessionKey("default-indep", tasks)).toBe(true)
  })

  it("rejects non-independent or invalid session keys", () => {
    expect(isIndependentTaskSessionKey("non-indep", tasks)).toBe(false)
    expect(isIndependentTaskSessionKey("ch_a|oc_x", tasks)).toBe(false)
    expect(isIndependentTaskSessionKey("unknown", tasks)).toBe(false)
  })
})

describe("scheduledTaskNotifyPromptLines", () => {
  it("includes notify_session_key and delivery rules", () => {
    const lines = scheduledTaskNotifyPromptLines("ch_a|oc_g")
    expect(lines[0]).toBe("[notify_session_key=ch_a|oc_g]")
    expect(lines.some((l) => l.includes("notify_session_key"))).toBe(true)
  })
})
