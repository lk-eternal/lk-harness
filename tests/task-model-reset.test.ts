import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ScheduledTask } from "../src/shared/scheduled-task"
import { resolveTaskLaunchModel } from "../src/shared/launch-model"
import { resetChangedTaskModelOverrides } from "../src/shared/task-model-reset"
import { initSessionOverridesStore, resetSessionOverridesStoreForTests, getSessionRecord, patchSessionRecord } from "../src/shared/session-overrides-store"
import { setSessionOverride } from "../src/shared/session-model-store"
import { listSessionEntryDirPaths } from "../src/shared/session-entry-paths"

/**
 * 保存任务设置后作废旧的会话模型覆盖。
 *
 * 出问题的链路：daemon 入队时只在任务「有模型」才往会话里登记 {模型, 供应商}；
 * 任务改回「跟随通道」或换了供应商后，旧登记还在，拉起时供应商和模型都先看会话登记，于是新设置不生效。
 * 会话存储用真实实现 + 临时目录。
 */

const TASK = "0b5f2c3e-1111-4222-8333-444455556666"
const OTHER = "9a8b7c6d-aaaa-4bbb-8ccc-ddddeeeeffff"

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: TASK, name: "日报", cron: "0 9 * * *", content: "x", enabled: true, independent: true, channelId: "ch_a", ...over,
})

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-model-reset-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("resetChangedTaskModelOverrides", () => {
  const before = [task({ model: "gpt-5", resourceId: "llm_b" }), task({ id: OTHER, model: "m" })]

  it("改过模型设置的任务：会话里的模型、参数、供应商都清掉；别的字段（续聊信息等）保留", () => {
    setSessionOverride(TASK, { model: "gpt-5", modelParams: "[1]", resourceId: "llm_b" })
    patchSessionRecord(TASK, { agentId: "agent-1", workspaceDir: "D:\\ws" })

    const reset = resetChangedTaskModelOverrides(before, [task({ model: "claude", resourceId: "sdk_a" }), before[1]])

    expect(reset).toEqual([TASK])
    const rec = getSessionRecord(TASK)
    expect(rec?.model).toBeUndefined()
    expect(rec?.modelParams).toBeUndefined()
    expect(rec?.resourceId).toBeUndefined()
    expect(rec?.agentId).toBe("agent-1")
    expect(rec?.workspaceDir).toBe("D:\\ws")
  })

  it("没改模型设置的任务不动，哪怕别的任务改了", () => {
    setSessionOverride(OTHER, { model: "m", resourceId: "sdk_a" })
    resetChangedTaskModelOverrides(before, [task({ model: "claude" }), before[1]])
    expect(getSessionRecord(OTHER)).toMatchObject({ model: "m", resourceId: "sdk_a" })
  })

  it("只改了名称、cron 等无关字段：不清", () => {
    setSessionOverride(TASK, { model: "gpt-5", resourceId: "llm_b" })
    const reset = resetChangedTaskModelOverrides(before, [{ ...before[0], name: "改名", cron: "0 8 * * *" }, before[1]])
    expect(reset).toEqual([])
    expect(getSessionRecord(TASK)).toMatchObject({ model: "gpt-5", resourceId: "llm_b" })
  })

  it("会话里本来就没有模型 / 供应商记录：什么都不写，也不凭空建出会话目录", () => {
    const reset = resetChangedTaskModelOverrides(before, [task({ model: "claude" }), before[1]])
    expect(reset).toEqual([])
    expect(getSessionRecord(TASK)).toBeUndefined()
    expect(listSessionEntryDirPaths(dataDir)).toEqual([])
  })

  it("新建和删除的任务不处理", () => {
    setSessionOverride(OTHER, { model: "m", resourceId: "sdk_a" })
    expect(resetChangedTaskModelOverrides(before, [before[0]])).toEqual([])
    expect(getSessionRecord(OTHER)).toMatchObject({ model: "m" })
    expect(resetChangedTaskModelOverrides([before[0]], before)).toEqual([])
  })
})

describe("作废之后拉起时按任务现在的设置解析（这是用户看到的结果）", () => {
  const KNOWN = new Set(["sdk_a", "llm_b"])
  const resolveResource = (id: string | undefined) => ({ id: id && KNOWN.has(id) ? id : "sdk_default" })
  const channel = { agentResourceId: "sdk_a", model: "composer-2", modelParams: "[]" }
  const resolve = (t: ScheduledTask) => resolveTaskLaunchModel({ sessionKey: TASK, task: t, channel, resolveResource })

  it("改回「跟随通道」：不作废时还停在旧供应商、旧模型；作废后跟随通道（修复前的行为 vs 现在）", () => {
    const withOwn = task({ model: "gpt-5", resourceId: "llm_b" })
    const followed = task({ model: undefined, modelParams: undefined, resourceId: undefined })
    // daemon 上一次触发时登记的
    setSessionOverride(TASK, { model: "gpt-5", modelParams: "", resourceId: "llm_b" })

    // 不作废：任务已经是跟随，实际却还用旧的
    expect(resolve(followed)).toMatchObject({ resolvedResourceId: "llm_b", model: "gpt-5" })

    resetChangedTaskModelOverrides([withOwn], [followed])
    expect(resolve(followed)).toMatchObject({ resolvedResourceId: "sdk_a", model: "composer-2", modelSource: "channel" })
  })

  it("换了供应商和模型：用新的", () => {
    const a = task({ model: "composer-2", resourceId: undefined })
    const b = task({ model: "gpt-5", resourceId: "llm_b" })
    setSessionOverride(TASK, { model: "composer-2", modelParams: "", resourceId: "sdk_a" })
    resetChangedTaskModelOverrides([a], [b])
    expect(resolve(b)).toMatchObject({ resolvedResourceId: "llm_b", model: "gpt-5" })
  })
})
