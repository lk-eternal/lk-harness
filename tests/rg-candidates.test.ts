import { describe, it, expect } from "vitest"
import { buildRipgrepCandidates } from "../electron/agent-sdk.js"

const base = {
  resolvePkgDir: (_pkg: string) => null,
  appDir: "/Applications/LK Harness.app/Contents/MacOS",
  cwd: "/tmp/xyz",
  pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
}

const norm = (ps: string[]) => ps.map((p) => p.replace(/\\/g, "/"));

describe("buildRipgrepCandidates", () => {
  it("Rosetta x64 转译包含 arm64 候选", () => {
    const out = norm(buildRipgrepCandidates({ ...base, platform: "darwin", arch: "x64" }))
    expect(out.some((p) => p.includes("@cursor/sdk-darwin-arm64"))).toBe(true)
    expect(out.some((p) => p.includes("@cursor/sdk-darwin-x64"))).toBe(true)
    expect(out.some((p) => p.endsWith("opt/homebrew/bin/rg"))).toBe(true)
  })
  it("原生 arm64 包含 x64 候选", () => {
    const out = norm(buildRipgrepCandidates({ ...base, platform: "darwin", arch: "arm64" }))
    expect(out.some((p) => p.includes("@cursor/sdk-darwin-x64"))).toBe(true)
  })
  it("win32 只要本架构 + rg.exe", () => {
    const out = norm(buildRipgrepCandidates({ ...base, platform: "win32", arch: "x64", pathEnv: "C:\\Windows" }))
    expect(out.some((p) => p.includes("darwin"))).toBe(false)
    expect(out.some((p) => p.endsWith("rg.exe"))).toBe(true)
  })
})
