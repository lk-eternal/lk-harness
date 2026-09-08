import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

describe("消息解析：媒体与占位", () => {
  it("media 记录封面 image_key 与视频 file_key", () => {
    const r = LarkSender.parseMessageContent("om_1", "media", JSON.stringify({
      file_key: "file_v3_abc", file_name: "20260908_153505.mp4", duration: 6100, image_key: "img_v3_cover",
    }))
    expect(r.text).toBe("[媒体: 20260908_153505.mp4 7s]")
    expect(r.imageKeys).toEqual([{ messageId: "om_1", imageKey: "img_v3_cover" }])
    expect(r.videoKeys).toEqual([{ messageId: "om_1", fileKey: "file_v3_abc", fileName: "20260908_153505.mp4" }])
  })

  it("video 记录 file_key", () => {
    const r = LarkSender.parseMessageContent("om_2", "video", JSON.stringify({
      file_key: "file_v3_xyz", file_name: "clip.mp4",
    }))
    expect(r.text).toBe("[视频: clip.mp4]")
    expect(r.videoKeys).toEqual([{ messageId: "om_2", fileKey: "file_v3_xyz", fileName: "clip.mp4" }])
  })

  it("无 file_key 时 videoKeys 为空（只收封面，不崩）", () => {
    const r = LarkSender.parseMessageContent("om_3", "media", JSON.stringify({
      file_name: "a.mp4", duration: 1000, image_key: "img_v3_x",
    }))
    expect(r.videoKeys).toEqual([])
    expect(r.imageKeys).toHaveLength(1)
  })
})
