import { describe, expect, it } from "vitest"
import {
  isBareSystemSessionKey,
  isolatedSessionWorkspaceDir,
  resolveSessionWorkspaceDir,
} from "../src/shared/session-workspace.js"

describe("session-workspace", () => {
  const userData = "C:/AppData/lk-harness-dev"

  it("isBareSystemSessionKey", () => {
    expect(isBareSystemSessionKey("temp_123")).toBe(true)
    expect(isBareSystemSessionKey("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true)
    expect(isBareSystemSessionKey("ch_a|oc_1")).toBe(false)
    expect(isBareSystemSessionKey("ch_a|oc_1::D:\\proj")).toBe(false)
  })

  it("resolveSessionWorkspaceDir uses path suffix when present", () => {
    const sk = "ch_a|oc_1::D:\\workspace\\lk-harness"
    expect(resolveSessionWorkspaceDir({ userDataDir: userData, sessionKey: sk })).toBe("D:\\workspace\\lk-harness")
  })

  it("resolveSessionWorkspaceDir sandboxes temp and task ids", () => {
    expect(resolveSessionWorkspaceDir({
      userDataDir: userData,
      sessionKey: "temp_1790070973658",
      mainWorkspaceDir: "D:\\main",
    })).toBe(isolatedSessionWorkspaceDir(userData, "temp_1790070973658"))

    expect(resolveSessionWorkspaceDir({
      userDataDir: userData,
      sessionKey: "task-uuid-1",
      mainWorkspaceDir: "D:\\main",
    })).toBe(isolatedSessionWorkspaceDir(userData, "task-uuid-1"))
  })

  it("resolveSessionWorkspaceDir uses main dir for bare chatKey only", () => {
    expect(resolveSessionWorkspaceDir({
      userDataDir: userData,
      sessionKey: "ch_a|oc_1",
      mainWorkspaceDir: "D:\\main",
    })).toBe("D:\\main")
  })
})
