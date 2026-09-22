import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

describe("file 消息只给路径", () => {
  it("file_key 进 fileKeys，正文只留文件名", () => {
    const content = JSON.stringify({ file_key: "file_v3_md123", file_name: "质检分析2026-09-21.md" })
    const r = LarkSender.parseMessageContent("om_md1", "file", content)
    expect(r.text).toBe("[文件: 质检分析2026-09-21.md]")
    expect(r.fileKeys).toEqual([{ messageId: "om_md1", fileKey: "file_v3_md123", fileName: "质检分析2026-09-21.md" }])
  })

  it("无 file_key 时 fileKeys 为空，不抛", () => {
    const r = LarkSender.parseMessageContent("om_md2", "file", JSON.stringify({ file_name: "a.md" }))
    expect(r.fileKeys).toEqual([])
    expect(r.text).toBe("[文件: a.md]")
  })

  it("video/media 旧行为不变", () => {
    const v = LarkSender.parseMessageContent("om_v", "video", JSON.stringify({ file_key: "fv", file_name: "c.mp4" }))
    expect(v.videoKeys).toEqual([{ messageId: "om_v", fileKey: "fv", fileName: "c.mp4" }])
    expect(v.fileKeys).toEqual([])
  })
})
