import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RESTART_MARKER_TTL_MS } from "../src/shared/silent-update"
import { clearRestartMarker, consumeStayHiddenMarker, writeRestartMarker } from "../electron/update-restart-marker"

let dir = ""
const markerFile = () => path.join(dir, "silent-update-restart.json")

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-restart-marker-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("重启记号：空闲自动重启前窗口是不是收在托盘里", () => {
  const now = 1_700_000_000_000

  it("窗口收着时写下记号，启动时读到：留在托盘；读完即删，只管这一次启动", () => {
    writeRestartMarker(dir, true, now)
    expect(fs.existsSync(markerFile())).toBe(true)
    expect(consumeStayHiddenMarker(dir, now + 20_000)).toBe(true)
    expect(fs.existsSync(markerFile())).toBe(false)
    // 下一次启动（手动打开）没有记号了：照常弹出来
    expect(consumeStayHiddenMarker(dir, now + 30_000)).toBe(false)
  })

  it("窗口本来就开着：记号写了，但启动时照常弹出来，同样读完即删", () => {
    writeRestartMarker(dir, false, now)
    expect(consumeStayHiddenMarker(dir, now + 20_000)).toBe(false)
    expect(fs.existsSync(markerFile())).toBe(false)
  })

  it("记号过期：不留在托盘，并且把过期的文件删掉", () => {
    writeRestartMarker(dir, true, now)
    expect(consumeStayHiddenMarker(dir, now + RESTART_MARKER_TTL_MS + 1)).toBe(false)
    expect(fs.existsSync(markerFile())).toBe(false)
  })

  it("没有记号文件：照常弹出来，也不会因为目录里什么都没有而抛错", () => {
    expect(consumeStayHiddenMarker(dir, now)).toBe(false)
    expect(consumeStayHiddenMarker(path.join(dir, "不存在的目录"), now)).toBe(false)
  })

  it("记号文件内容坏了、字段不对：照常弹出来，坏文件也删掉", () => {
    for (const bad of ["{not json", "[]", "null", JSON.stringify({ at: "x", keepHidden: true }), JSON.stringify({ at: now, keepHidden: "yes" }), JSON.stringify({ keepHidden: true })]) {
      fs.writeFileSync(markerFile(), bad, "utf-8")
      expect(consumeStayHiddenMarker(dir, now)).toBe(false)
      expect(fs.existsSync(markerFile())).toBe(false)
    }
  })

  it("重启没有真正发生时撤销记号：之后手动打开不受影响；没有记号时撤销也不报错", () => {
    writeRestartMarker(dir, true, now)
    clearRestartMarker(dir)
    expect(fs.existsSync(markerFile())).toBe(false)
    expect(consumeStayHiddenMarker(dir, now + 1000)).toBe(false)
    expect(() => clearRestartMarker(dir)).not.toThrow()
  })

  it("目录写不进去：写记号不抛错（最坏是装完窗口照常弹出来）", () => {
    expect(() => writeRestartMarker(path.join(dir, "不存在的目录", "更深"), true, now)).not.toThrow()
  })
})
