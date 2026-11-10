import { describe, expect, it } from "vitest"
import { parseByteRange } from "../src/shared/preview-range"

describe("parseByteRange", () => {
  it("没有头 / 不认识的写法：null，整份返回", () => {
    expect(parseByteRange(undefined, 100)).toBeNull()
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange("", 100)).toBeNull()
    expect(parseByteRange("items=0-1", 100)).toBeNull()
    expect(parseByteRange("bytes=-", 100)).toBeNull()
    expect(parseByteRange("garbage", 100)).toBeNull()
    // 多段范围不支持，按整份返回
    expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull()
  })

  it("起止都给：含两端", () => {
    expect(parseByteRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 })
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange("BYTES = 5 - 9", 100)).toEqual({ start: 5, end: 9 })
  })

  it("只给起点：到文件末尾（视频拖动进度的常见请求）", () => {
    expect(parseByteRange("bytes=40-", 100)).toEqual({ start: 40, end: 99 })
    expect(parseByteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 })
  })

  it("终点超出文件：收到末尾", () => {
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 })
  })

  it("后缀范围：最后 N 个字节，N 比文件大就是整份", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 })
  })

  it("范围落在文件之外：unsatisfiable（回 416）", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=100-200", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=50-10", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable")
    expect(parseByteRange("bytes=0-10", 0)).toBe("unsatisfiable")
  })
})
