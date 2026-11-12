import { describe, expect, it } from "vitest"

/**
 * 守卫：测试进程里不能带着应用的 APP_DATA_DIR（指向真实用户数据目录）。
 * 在应用里起的 Agent 终端会继承它；没有 tests/setup/isolate-env.ts 的话，单元测试会把会话目录写进真实目录。
 */
describe("测试环境隔离", () => {
  it("测试进程里没有继承来的 APP_DATA_DIR", () => {
    expect(process.env.APP_DATA_DIR).toBeUndefined()
  })
})
