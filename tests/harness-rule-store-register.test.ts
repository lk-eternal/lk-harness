/**
 * 规则保存时要登记到清单（manifest 的 order）。
 *
 * 修过的问题：manage_rules 的 save 把新规则的名字同时当成「旧 id」传给 saveHarnessRule，
 * 它走了「更新已有规则」的分支：只写文件、不登记。结果 list 看不到、read 报 not found、
 * 提示词里也不会带上——返回「已保存」，规则却永远不生效。磁盘上留下了没登记的孤儿文件。
 */
import { beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  deleteHarnessRule,
  initHarnessRuleStore,
  listEnabledHarnessRules,
  listHarnessRules,
  saveHarnessRule,
} from "../src/shared/harness-rule-store.js"

let dir = ""
const rulesDir = () => path.join(dir, "harness-rules")
const manifest = () => JSON.parse(fs.readFileSync(path.join(rulesDir(), "manifest.json"), "utf8")) as { order: string[]; scopes?: Record<string, unknown> }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrule-reg-"))
  initHarnessRuleStore(dir)
})

describe("saveHarnessRule：登记到规则清单", () => {
  it("新建（id 为 null）：登记，默认仅主用户", () => {
    const saved = saveHarnessRule(null, "更新日志写法", "正文", true)
    expect(saved?.id).toBe("更新日志写法")
    expect(listHarnessRules().map((r) => r.id)).toEqual(["更新日志写法"])
    expect(listHarnessRules()[0].scope).toEqual({ mode: "main" })
    expect(listEnabledHarnessRules().map((r) => r.id)).toEqual(["更新日志写法"])
  })

  it("id 和名字相同、但从没登记过（manage_rules 的 save 就是这样调的）：必须登记", () => {
    const saved = saveHarnessRule("发版规则", "发版规则", "正文", true)
    expect(saved?.id).toBe("发版规则")
    expect(manifest().order).toEqual(["发版规则"])
    const rule = listHarnessRules().find((r) => r.id === "发版规则")
    expect(rule?.content.trim()).toBe("正文")
    expect(rule?.enabled).toBe(true)
    expect(listEnabledHarnessRules().map((r) => r.id)).toContain("发版规则")
  })

  it("磁盘上已有文件、清单里没有（孤儿）：保存同名规则会补登记，并以新内容为准", () => {
    fs.mkdirSync(rulesDir(), { recursive: true })
    fs.writeFileSync(path.join(rulesDir(), "孤儿.mdc"), "旧内容\n")
    expect(listHarnessRules().map((r) => r.id)).toEqual([]) // 没登记，看不到

    saveHarnessRule("孤儿", "孤儿", "新内容", true)

    expect(listHarnessRules().map((r) => r.id)).toEqual(["孤儿"])
    expect(listHarnessRules()[0].content.trim()).toBe("新内容")
  })

  it("已登记的规则按 id 更新：不会在清单里出现两次，范围保持不变", () => {
    saveHarnessRule(null, "r1", "v1", true, { mode: "custom", targets: [{ channelId: "ch_a", audiences: ["others"] }] })
    saveHarnessRule("r1", "r1", "v2", true)

    expect(manifest().order).toEqual(["r1"])
    const rule = listHarnessRules()[0]
    expect(rule.content.trim()).toBe("v2")
    expect(rule.scope).toEqual({ mode: "custom", targets: [{ channelId: "ch_a", audiences: ["others"] }] })
  })

  it("登记不影响顺序：已有规则在前，新补登记的排在最后", () => {
    saveHarnessRule(null, "a", "1")
    saveHarnessRule(null, "b", "2")
    saveHarnessRule("c", "c", "3")
    expect(manifest().order).toEqual(["a", "b", "c"])
  })

  it("补登记后删除：清单和文件都干净", () => {
    saveHarnessRule("x", "x", "1")
    expect(deleteHarnessRule("x")).toBe(true)
    expect(manifest().order).toEqual([])
    expect(fs.existsSync(path.join(rulesDir(), "x.mdc"))).toBe(false)
  })

  it("重命名成已存在的规则名：仍然拒绝，不覆盖别人", () => {
    saveHarnessRule(null, "a", "1")
    saveHarnessRule(null, "b", "2")
    expect(saveHarnessRule("a", "b", "x")).toBeNull()
    expect(listHarnessRules().map((r) => r.content.trim()).sort()).toEqual(["1", "2"])
  })
})
