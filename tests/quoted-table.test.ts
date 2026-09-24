import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { LarkSender } from "../src/shared/lark-core.js"
import {
  initCarryoverStore,
  resetCarryoverStoreForTests,
  appendMirrorTurns,
  readMirrorTurns,
} from "../electron/carryover.js"
import { assembleTurnPrompt } from "../electron/prompt-assembler.js"

describe("引用卡片表格：发卡方真形态", () => {
  it("columns + 对象行 + 数组 cell 全量铺开", () => {
    const content = JSON.stringify({
      schema: "2.0",
      header: { title: { content: "Daily Slow SQL Report" } },
      body: {
        elements: [
          { tag: "markdown", content: "**Max Top 10**" },
          {
            tag: "table",
            columns: [
              { name: "trace_id", display_name: "trace_id" },
              { name: "db", display_name: "db" },
              { name: "avg_ms", display_name: "avg_ms" },
            ],
            rows: [
              { trace_id: "abc123", db: "scheduling", avg_ms: 812 },
              { trace_id: [{ text: "def456", color: "red" }], db: "scheduling", avg_ms: 640 },
            ],
          },
        ],
      },
    })
    const r = LarkSender.parseMessageContent("om_1", "interactive", content)
    expect(r.text).toContain("Daily Slow SQL Report")
    expect(r.text).toContain("**Max Top 10**")
    expect(r.text).toContain("trace_id | db | avg_ms")
    expect(r.text).toContain("abc123 | scheduling | 812")
    expect(r.text).toContain("def456 | scheduling | 640")
  })

  it("旧形态 header.titles + 数组行仍兼容", () => {
    const content = JSON.stringify({
      elements: [
        {
          tag: "table",
          header: { titles: [{ content: "a" }, { content: "b" }] },
          rows: [[{ content: "1" }, { content: "2" }]],
        },
      ],
    })
    const r = LarkSender.parseMessageContent("om_2", "interactive", content)
    expect(r.text).toContain("a | b")
    expect(r.text).toContain("1 | 2")
  })
})

describe("发送方归一：bot 不再判成 user", () => {
  it("app→bot", () => {
    expect(LarkSender.normalizeSender({ sender_type: "app", sender_id: { open_id: "ou_x" } }))
      .toEqual({ senderType: "bot", senderOpenId: "ou_x" })
  })
  it("缺字段但有 app_id 即 bot", () => {
    expect(LarkSender.normalizeSender({ sender_id: { app_id: "cli_x" } }))
      .toEqual({ senderType: "bot", senderOpenId: "cli_x" })
  })
  it("user 保持 user", () => {
    expect(LarkSender.normalizeSender({ sender_type: "user", sender_id: { open_id: "ou_u" } }))
      .toEqual({ senderType: "user", senderOpenId: "ou_u" })
  })
  it("open_bot_id 回落", () => {
    expect(LarkSender.normalizeSender({ sender_type: "app", sender_id: {}, open_bot_id: "ou_bot" }))
      .toEqual({ senderType: "bot", senderOpenId: "ou_bot" })
  })
})

describe("投递与镜像带引用", () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-quoted-"))
    initCarryoverStore(dataDir)
  })
  afterEach(() => {
    resetCarryoverStoreForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it("internal_ 队列 id 不写入本轮投递 message_id", () => {
    const out = assembleTurnPrompt(
      [{ text: "任务正文", messageId: "internal_enqueue_1", meta: { senderType: "user", senderOpenId: "ou_u" } }],
      { meta: { chatType: "p2p" } },
    )
    const payload = JSON.parse(out.match(/```json\s*([\s\S]*?)```/)![1])
    expect(payload.messages[0]).toEqual({ sender_type: "user", sender_open_id: "ou_u", text: "任务正文" })
    expect(payload.messages[0]).not.toHaveProperty("message_id")
  })

  it("本轮投递装 quoted_message 对象", () => {
    const out = assembleTurnPrompt(
      [{
        text: "帮忙分析一下排课的慢sql",
        messageId: "om_new",
        meta: {
          senderType: "user",
          senderOpenId: "ou_u",
          quoted_message: { message_id: "om_q", sender_type: "bot", sender_open_id: "ou_bot", text: "慢sql表" },
        },
      }],
      { sessionKey: "sk" },
    )
    const payload = JSON.parse(out.match(/```json\s*([\s\S]*?)```/)![1])
    expect(payload.messages[0].quoted_message).toEqual({
      message_id: "om_q", sender_type: "bot", sender_open_id: "ou_bot", text: "慢sql表",
    })
    expect(payload.messages[0]).not.toHaveProperty("quoted_content")
  })

  it("mirror 往返保留引用", () => {
    appendMirrorTurns("sk", [
      {
        role: "user",
        text: "结合昨天那批一起看",
        quoted_message: { message_id: "om_q", sender_type: "bot", text: "旧表" },
      },
    ])
    expect(readMirrorTurns("sk")).toEqual([
      {
        role: "user",
        text: "结合昨天那批一起看",
        quoted_message: { message_id: "om_q", sender_type: "bot", text: "旧表" },
      },
    ])
  })
})
