import { describe, expect, it } from "vitest"
import { drainSseFrames } from "../src/mobile/sse-parse"

describe("drainSseFrames", () => {
  it("extracts complete frames and keeps the partial tail", () => {
    const out = drainSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
    expect(out.payloads).toEqual(['{"a":1}', '{"b":2}'])
    expect(out.rest).toBe('data: {"c"')
  })

  it("completes a frame split across chunks", () => {
    const first = drainSseFrames('data: {"type":"rea')
    expect(first.payloads).toEqual([])
    const second = drainSseFrames(first.rest + 'dy"}\n\n')
    expect(second.payloads).toEqual(['{"type":"ready"}'])
    expect(second.rest).toBe("")
  })

  it("ignores heartbeat comments", () => {
    expect(drainSseFrames(": ping\n\n").payloads).toEqual([])
    expect(drainSseFrames(': ping\n\ndata: {"x":1}\n\n').payloads).toEqual(['{"x":1}'])
  })

  it("handles CRLF line endings and multi-line data", () => {
    expect(drainSseFrames("data: one\r\ndata: two\r\n\r\n").payloads).toEqual(["one\ntwo"])
  })
})
