import { describe, expect, it } from "vitest"
import {
  buildSkillCatalog,
  planSkillInjection,
  SKILL_CATALOG_BUDGET,
  SKILL_DESC_MAX,
  withUpdateNotice,
  type CatalogRoot,
  type CatalogSkill,
} from "../src/shared/skill-catalog"

const sk = (name: string, description = `${name} 的说明`, folder = name): CatalogSkill => ({ name, folder, description })
const root = (dir: string, ...skills: CatalogSkill[]): CatalogRoot => ({ dir, skills })
const lines = (text: string) => text.split("\n")

describe("buildSkillCatalog：基本格式", () => {
  it("没有任何 Skill：空文本，不是只有标题", () => {
    expect(buildSkillCatalog([])).toEqual({ text: "", count: 0, full: 0, listed: 0 })
    expect(buildSkillCatalog([root("/a"), root("/b")]).text).toBe("")
  })

  it("目录路径只写一次，条目写「名字：说明」不重复路径", () => {
    const { text, count, full, listed } = buildSkillCatalog([root("/home/u/.cursor/skills", sk("alpha"), sk("beta"))])
    expect({ count, full, listed }).toEqual({ count: 2, full: 2, listed: 2 })
    expect(text).toContain("## 本机 Skill")
    expect(text).toContain("### /home/u/.cursor/skills")
    expect(text).toContain("- alpha：alpha 的说明")
    expect(text).toContain("- beta：beta 的说明")
    expect(text.split("/home/u/.cursor/skills").length - 1).toBe(1)
  })

  it("没有说明的条目只写名字，不留孤零零的冒号", () => {
    const { text } = buildSkillCatalog([root("/a", sk("quiet", ""))])
    expect(lines(text)).toContain("- quiet")
    expect(text).not.toContain("quiet：")
  })

  it("名字和文件夹不一致时标出目录；分层的 Skill 写相对路径", () => {
    const { text } = buildSkillCatalog([root("/a", sk("显示名", "说明", "real-dir"), sk("nested", "说明", "group/nested"))])
    expect(text).toContain("- 显示名（目录 real-dir）：说明")
    expect(text).toContain("- nested（目录 group/nested）：说明")
  })

  it("没有 Skill 的目录不出现标题", () => {
    const { text } = buildSkillCatalog([root("/empty"), root("/full", sk("x"))])
    expect(text).not.toContain("/empty")
    expect(text).toContain("### /full")
  })
})

describe("buildSkillCatalog：去重和顺序", () => {
  it("同名只留先出现的目录里那份（目录顺序就是优先级）", () => {
    const { text, count } = buildSkillCatalog([
      root("/first", sk("dup", "来自第一个目录")),
      root("/second", sk("dup", "来自第二个目录"), sk("only-second")),
    ])
    expect(count).toBe(2)
    expect(text).toContain("来自第一个目录")
    expect(text).not.toContain("来自第二个目录")
    expect(text).toContain("only-second")
  })

  it("同名的 Skill 被去掉后，整个目录都没剩下就不写标题", () => {
    const { text } = buildSkillCatalog([root("/a", sk("dup")), root("/b", sk("dup"))])
    expect(text).toContain("### /a")
    expect(text).not.toContain("### /b")
  })

  it("目录内按名字排序：输入顺序变了，文本不变（提示词缓存才命中）", () => {
    const a = buildSkillCatalog([root("/a", sk("c"), sk("a"), sk("b"))])
    const b = buildSkillCatalog([root("/a", sk("b"), sk("c"), sk("a"))])
    expect(a.text).toBe(b.text)
    const names = lines(a.text).filter((l) => l.startsWith("- ")).map((l) => l.slice(2, 3))
    expect(names).toEqual(["a", "b", "c"])
  })

  it("目录之间保持传入顺序，不会按路径重排", () => {
    const { text } = buildSkillCatalog([root("/z-first", sk("x")), root("/a-second", sk("y"))])
    expect(text.indexOf("/z-first")).toBeLessThan(text.indexOf("/a-second"))
  })

  it("名字为空的条目直接丢掉", () => {
    const { count, text } = buildSkillCatalog([root("/a", sk("", "没名字"), sk("ok"))])
    expect(count).toBe(1)
    expect(text).not.toContain("没名字")
  })

  it("同样的输入，两次结果完全一样（没有时间戳之类的东西）", () => {
    const input = [root("/a", sk("x"), sk("y")), root("/b", sk("z"))]
    expect(buildSkillCatalog(input).text).toBe(buildSkillCatalog(input).text)
  })
})

describe("buildSkillCatalog：说明截断", () => {
  it(`默认每条说明最多 ${SKILL_DESC_MAX} 字，超出加省略号`, () => {
    const long = "说".repeat(SKILL_DESC_MAX + 50)
    const { text } = buildSkillCatalog([root("/a", sk("x", long))])
    expect(text).toContain(`- x：${"说".repeat(SKILL_DESC_MAX)}…`)
    expect(text).not.toContain("说".repeat(SKILL_DESC_MAX + 1))
  })

  it("刚好等于上限：不加省略号", () => {
    const exact = "说".repeat(SKILL_DESC_MAX)
    const { text } = buildSkillCatalog([root("/a", sk("x", exact))])
    expect(text).toContain(`- x：${exact}`)
    expect(text).not.toContain("…")
  })

  it("说明里的换行和多余空白压成一个空格，一条说明永远只占一行", () => {
    const { text } = buildSkillCatalog([root("/a", sk("x", "第一行\n\n  第二行\t第三行"))])
    expect(text).toContain("- x：第一行 第二行 第三行")
  })

  it("descMax 可调", () => {
    const { text } = buildSkillCatalog([root("/a", sk("x", "0123456789"))], { descMax: 4 })
    expect(text).toContain("- x：0123…")
  })
})

describe("buildSkillCatalog：预算", () => {
  const many = (n: number, desc = "说明".repeat(20)): CatalogRoot[] => [
    root("/a", ...Array.from({ length: n }, (_, i) => sk(`skill-${String(i).padStart(3, "0")}`, desc))),
  ]

  it("放得下：全部带说明，不超预算", () => {
    const r = buildSkillCatalog(many(10))
    expect(r.full).toBe(10)
    expect(r.listed).toBe(10)
    expect(r.text.length).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET)
  })

  it("放不下：靠前的带说明，尾部降级成「仅列名字」，数量一个不少，总长不超预算", () => {
    const r = buildSkillCatalog(many(200), { budget: 3000 })
    expect(r.count).toBe(200)
    expect(r.listed).toBe(200)
    expect(r.full).toBeGreaterThan(0)
    expect(r.full).toBeLessThan(200)
    expect(r.text.length).toBeLessThanOrEqual(3000)
    // 带说明的是最靠前的 full 条，接着一行「仅列名字」从第 full 条开始、到最后一条为止
    const pad = (i: number) => `skill-${String(i).padStart(3, "0")}`
    expect(r.text).toContain(`- ${pad(0)}：`)
    expect(r.text).toContain(`- ${pad(r.full - 1)}：`)
    expect(r.text).not.toContain(`- ${pad(r.full)}：`)
    const bare = lines(r.text).find((l) => l.startsWith("- 仅列名字："))!
    expect(bare.startsWith(`- 仅列名字：${pad(r.full)}、`)).toBe(true)
    expect(bare.endsWith(`、${pad(199)}`)).toBe(true)
    expect(bare.split("、").length).toBe(200 - r.full)
  })

  it("降级是「尽量多带说明」：再多带一条就会超预算", () => {
    const r = buildSkillCatalog(many(200), { budget: 3000 })
    // 少一条预算就必须少带说明
    const tighter = buildSkillCatalog(many(200), { budget: r.text.length - 1 })
    expect(tighter.full).toBeLessThan(r.full)
  })

  it("预算比全部名字还小：少列几个，写明还有多少没列", () => {
    const r = buildSkillCatalog(many(200), { budget: 600 })
    expect(r.count).toBe(200)
    expect(r.listed).toBeLessThan(200)
    expect(r.listed).toBeGreaterThan(0)
    expect(r.full).toBe(0)
    expect(r.text.length).toBeLessThanOrEqual(600)
    expect(r.text).toContain(`（另有 ${200 - r.listed} 个 Skill 未列出）`)
  })

  it("预算小到连一个名字都放不下：只剩标题和「另有 N 个」，不抛错", () => {
    const r = buildSkillCatalog(many(5), { budget: 10 })
    expect(r.listed).toBe(0)
    expect(r.text).toContain("（另有 5 个 Skill 未列出）")
  })

  it("降级跨目录也成立：后面的目录先变成只列名字", () => {
    const r = buildSkillCatalog(
      [
        root("/first", ...Array.from({ length: 5 }, (_, i) => sk(`a${i}`, "长".repeat(100)))),
        root("/second", ...Array.from({ length: 5 }, (_, i) => sk(`b${i}`, "长".repeat(100)))),
      ],
      { budget: 900 },
    )
    expect(r.text).toContain("- a0：")
    const second = r.text.slice(r.text.indexOf("### /second"))
    expect(second).toContain("- 仅列名字：")
  })

  it("默认预算就是 10k 字符", () => {
    expect(SKILL_CATALOG_BUDGET).toBe(10_000)
    const r = buildSkillCatalog(many(500))
    expect(r.text.length).toBeLessThanOrEqual(SKILL_CATALOG_BUDGET)
  })
})

describe("withUpdateNotice", () => {
  it("名单有变化时在前面说明这份替代之前的", () => {
    const t = withUpdateNotice("## 本机 Skill\nx")
    expect(t.startsWith("（Skill 名单有变化")).toBe(true)
    expect(t.endsWith("## 本机 Skill\nx")).toBe(true)
  })

  it("空名单不加说明（没有名单就别发一句孤零零的提示）", () => {
    expect(withUpdateNotice("")).toBe("")
  })
})

describe("planSkillInjection：这次拉起要不要带名单", () => {
  const current = { text: "## 本机 Skill\n- a：甲", hash: "h2", count: 1 }

  it("新账本（AI 手里还没有名单）：带原文，不加「有变化」的说明", () => {
    const p = planSkillInjection(current, undefined)
    expect(p).toEqual({ text: current.text, hash: "h2", reason: "new-ledger" })
    expect(p!.text).not.toContain("名单有变化")
  })

  it("AI 手里的就是这一版：不带（续跑的会话每次拉起都很安静）", () => {
    expect(planSkillInjection(current, "h2")).toBeUndefined()
  })

  it("AI 手里的是旧版：补发最新的，并说明以这份为准", () => {
    const p = planSkillInjection(current, "h1")
    expect(p).toMatchObject({ hash: "h2", reason: "changed" })
    expect(p!.text).toBe(withUpdateNotice(current.text))
    expect(p!.text).toContain("以这份为准")
  })

  it("本机没有可列的 Skill：什么都不带，不管 AI 手里有没有旧版", () => {
    const none = { text: "", hash: "", count: 0 }
    expect(planSkillInjection(none, undefined)).toBeUndefined()
    expect(planSkillInjection(none, "h1")).toBeUndefined()
  })

  it("count 为 0 但文本非空 / 文本为空但 count 非 0 这种自相矛盾的输入：保守地不带", () => {
    expect(planSkillInjection({ text: "x", hash: "h", count: 0 }, undefined)).toBeUndefined()
    expect(planSkillInjection({ text: "", hash: "h", count: 3 }, undefined)).toBeUndefined()
  })

  it("一连串拉起：新账本带一次 → 之后都不带 → 名单变了补一次 → 又安静", () => {
    let sent: string | undefined
    const launch = (cur: typeof current) => {
      const p = planSkillInjection(cur, sent)
      if (p) sent = p.hash // 对应 worker 里「交付成功才记指纹」
      return p?.reason
    }
    const v2 = { ...current, hash: "h3", text: "## 本机 Skill\n- a：甲\n- b：乙", count: 2 }
    expect([launch(current), launch(current), launch(current), launch(v2), launch(v2)]).toEqual([
      "new-ledger", undefined, undefined, "changed", undefined,
    ])
  })

})