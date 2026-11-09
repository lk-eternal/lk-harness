import { beforeEach, describe, expect, it, vi } from "vitest"

const cli = vi.hoisted(() => ({
  authenticated: vi.fn<() => Promise<boolean>>(),
  run: vi.fn<(args: string[], timeoutMs?: number) => Promise<unknown>>(),
}))

vi.mock("../src/shared/meegle-cli.js", () => ({
  meegleAuthenticated: cli.authenticated,
  runMeegleJson: cli.run,
}))

import { listFeishuProjectsForPicker } from "../src/shared/meegle-project-picker.js"

type Story = { id: number; name: string; status: string }
type Tech = { id: number; name: string }

/** 模拟飞书项目里「我参与且进行中」的需求；测试里改它就等于在飞书项目里改了数据。 */
const remote: { stories: Story[]; techs: Tech[] } = { stories: [], techs: [] }

function moqlRows(rows: Array<Record<string, string | number | string[]>>) {
  return {
    data: {
      "1": rows.map((row) => ({
        moql_field_list: Object.entries(row).map(([key, v]) =>
          typeof v === "number"
            ? { key, value_type: "long_value", value: { long_value: v } }
            : Array.isArray(v)
              ? { key, value_type: "key_label_value_list", value: { key_label_value_list: v.map((label) => ({ label })) } }
              : { key, value_type: "string_value", value: { string_value: v } },
        ),
      })),
    },
  }
}

function answerQuery(args: string[]): unknown {
  const p = args[args.indexOf("-P") + 1]
  const mql = (JSON.parse(p) as { mql: string }).mql
  if (mql.includes("`产品需求`")) {
    return moqlRows(remote.stories.map((s) => ({ work_item_id: s.id, name: s.name, work_item_status: [ s.status ] })))
  }
  return moqlRows(remote.techs.map((t) => ({ work_item_id: t.id, name: t.name })))
}

describe("listFeishuProjectsForPicker", () => {
  beforeEach(() => {
    remote.stories = [ { id: 1, name: "排课专项", status: "测试中" } ]
    remote.techs = [ { id: 2, name: "系统性能优化" } ]
    cli.authenticated.mockReset().mockResolvedValue(true)
    cli.run.mockReset().mockImplementation(async (args) => answerQuery(args))
  })

  it("每次都重新向飞书项目查询：期间新加入的需求下一次就能看到", async () => {
    const first = await listFeishuProjectsForPicker()
    expect(first?.map((i) => i.workItemId).sort()).toEqual([ "1", "2" ])

    // 用户在飞书项目里把自己加成了某个需求的负责人，然后同一个会话里再发一次 /p new
    remote.stories.push({ id: 3, name: "袋鼠课课时兑换专项", status: "待开发" })

    const second = await listFeishuProjectsForPicker()
    expect(second?.map((i) => i.workItemId).sort()).toEqual([ "1", "2", "3" ])
    // 产品需求、技术需求各一条查询，两次调用共 4 次，没有被缓存吞掉
    expect(cli.run).toHaveBeenCalledTimes(4)
  })

  it("需求被移出（例如已上线）后下一次也不再出现", async () => {
    await listFeishuProjectsForPicker()
    remote.techs = []
    const again = await listFeishuProjectsForPicker()
    expect(again?.map((i) => i.workItemId)).toEqual([ "1" ])
  })

  it("查询失败时返回 null，不拿旧列表顶替", async () => {
    expect(await listFeishuProjectsForPicker()).not.toBeNull()
    cli.run.mockRejectedValue(new Error("timeout"))
    expect(await listFeishuProjectsForPicker()).toBeNull()
  })

  it("meegle 未登录时返回 null，且不发查询", async () => {
    cli.authenticated.mockResolvedValue(false)
    expect(await listFeishuProjectsForPicker()).toBeNull()
    expect(cli.run).not.toHaveBeenCalled()
  })
})
