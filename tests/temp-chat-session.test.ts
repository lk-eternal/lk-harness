import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createTempChatSession } from "../src/shared/temp-chat-session.js"

describe("createTempChatSession", () => {
  it("builds chatKey::workspace path and creates directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-temp-"))
    const chatId = "ch_a|oc_b"
    const { sessionKey, workspaceDir } = createTempChatSession(root, chatId)
    expect(sessionKey.startsWith(`${chatId}::`)).toBe(true)
    expect(sessionKey).toContain("temp_")
    expect(fs.existsSync(workspaceDir)).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("同一毫秒里连建多个：各自一个目录、会话键不撞（定时任务批量建专属会话）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-temp-"))
    const made = Array.from({ length: 5 }, () => createTempChatSession(root, "ch_a|app_main"))
    expect(new Set(made.map((m) => m.sessionKey)).size).toBe(5)
    expect(new Set(made.map((m) => m.workspaceDir)).size).toBe(5)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
