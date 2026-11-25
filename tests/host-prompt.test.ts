/**
 * 宿主提示词（协议、规则、Skill 名单整份）怎么构建、什么时候给：
 * - buildHostPrompt：协议块加 Skill 名单，附带文本指纹
 * - planHostPrompt：SDK 这一轮要不要给——账本里 AI 手里那一版的指纹和现在的一样就不给
 * - assembleSdkWorkerTurnPrompt：给的话放在信封之前
 * - Pi 引擎：同一份文本整个放进 appendSystemPrompt，Pi 自己的 Skill 清单关掉
 * 宿主提示词的组装走真实的，只桩掉 Electron / 配置 / daemon / 名单扫描这些无关依赖。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", async () => {
  const p = await import("node:path")
  const f = await import("node:fs")
  const o = await import("node:os")
  const userData = f.mkdtempSync(p.join(o.tmpdir(), "lskill-userdata-"))
  return { app: { isPackaged: false, getAppPath: () => p.resolve(process.cwd()), getPath: () => userData } }
})
vi.mock("../electron/config-store", () => ({
  getConfig: () => ({ digitalIdentity: "", daemonPort: 19528, channels: [] }),
  getChannel: () => undefined,
}))
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => null }))
vi.mock("../electron/cron-scheduler", () => ({ readTasksFromFile: () => [] }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {}, pushUiLog: () => {} }))

const scan = vi.hoisted(() => ({
  value: { text: "", hash: "", count: 0 } as { text: string; hash: string; count: number },
  calls: [] as unknown[][],
}))
vi.mock("../electron/skill-catalog", () => ({
  getSkillCatalog: (...args: unknown[]) => {
    scan.calls.push(args)
    return scan.value
  },
}))

import { DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent"
import {
  assembleProtocolBlocks,
  assembleSdkWorkerTurnPrompt,
  buildHostPrompt,
  planHostPrompt,
  type PromptAssemblyContext,
} from "../electron/prompt-assembler.js"
import { buildAppendSystemPrompt, PI_SKILL_LOADING } from "../electron/pi-embedded.js"
import { joinPromptBlocks } from "../src/shared/prompt-markup.js"
import { resolveVisitorLimits } from "../src/shared/visitor-limits.js"

const CATALOG = "# Skill\n\n本机有下面这些 Skill：\n\n<skills dir=\"/home/u/.cursor/skills\">\n- alpha：甲\n</skills>"
const CATALOG_V2 = `${CATALOG}\n- beta：乙`
const USER_TEXT = "用户这一句-XYZ"
const CTX: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true }
const MSGS = [{ text: USER_TEXT, messageId: "m1" }]
const NOTICE = "（以下协议、规则和 Skill 名单有更新，以这份为准）"

const withCatalog = (text: string) => { scan.value = { text, hash: "unused", count: text ? 1 : 0 } }

beforeEach(() => {
  scan.value = { text: "", hash: "", count: 0 }
  scan.calls.length = 0
})

describe("buildHostPrompt：协议块加 Skill 名单", () => {
  it("有名单：协议块之后隔一个空行接名单，整体是一个字符串", () => {
    withCatalog(CATALOG)
    const { text } = buildHostPrompt(CTX)
    const protocol = joinPromptBlocks(assembleProtocolBlocks(CTX))
    expect(text.startsWith(protocol)).toBe(true)
    expect(text.endsWith(`\n\n${CATALOG}`)).toBe(true)
  })

  it("没有名单：只有协议，尾部不留空行", () => {
    const { text } = buildHostPrompt(CTX)
    expect(text).toBe(joinPromptBlocks(assembleProtocolBlocks(CTX)))
    expect(text).not.toContain("本机有下面这些 Skill")
  })

  it("指纹是文本的指纹：同样的内容同样的指纹，名单变了指纹就变", () => {
    withCatalog(CATALOG)
    const a = buildHostPrompt(CTX)
    expect(buildHostPrompt(CTX).hash).toBe(a.hash)
    withCatalog(CATALOG_V2)
    expect(buildHostPrompt(CTX).hash).not.toBe(a.hash)
  })

  it("访客只列被点名开放的 Skill：名单按 visitor.skillAllow 去取，不受限的会话不过滤", () => {
    buildHostPrompt(CTX)
    expect(scan.calls[0]![1]).toBeUndefined()
    const visitor = resolveVisitorLimits({ visitorTier: "visitor", visitorSkills: ["weekly-report"] }, "others")!
    buildHostPrompt({ ...CTX, visitor })
    expect(scan.calls[1]![1]).toEqual(["weekly-report"])
  })
})

describe("planHostPrompt：这一轮要不要给", () => {
  it("新账本（AI 手里还没有）：给原文，不加「有更新」的说明", () => {
    withCatalog(CATALOG)
    const host = buildHostPrompt(CTX)
    const plan = planHostPrompt(CTX, undefined)
    expect(plan).toEqual({ text: host.text, hash: host.hash, reason: "new-ledger" })
    expect(plan!.text).not.toContain(NOTICE)
  })

  it("AI 手里的就是现在这一版：不给", () => {
    withCatalog(CATALOG)
    expect(planHostPrompt(CTX, buildHostPrompt(CTX).hash)).toBeUndefined()
  })

  it("AI 手里的是旧版：补发最新的整份，开头说明以这份为准", () => {
    withCatalog(CATALOG)
    const old = buildHostPrompt(CTX).hash
    withCatalog(CATALOG_V2)
    const host = buildHostPrompt(CTX)
    const plan = planHostPrompt(CTX, old)
    expect(plan).toMatchObject({ hash: host.hash, reason: "changed" })
    expect(plan!.text).toBe(`${NOTICE}\n${host.text}`)
  })

  it("本机没有 Skill 时也照常给协议：没有名单不影响协议块", () => {
    const plan = planHostPrompt(CTX, undefined)
    expect(plan?.reason).toBe("new-ledger")
    expect(plan!.text).toContain("# 身份")
  })

  it("一连串轮次：新账本给一次 → 之后都不给 → 名单变了补一次 → 又安静", () => {
    let delivered: string | undefined
    const turn = () => {
      const p = planHostPrompt(CTX, delivered)
      if (p) delivered = p.hash // 对应 worker 里「交付成功才记指纹」
      return p?.reason
    }
    withCatalog(CATALOG)
    const first = [turn(), turn(), turn()]
    withCatalog(CATALOG_V2)
    const after = [turn(), turn()]
    expect([...first, ...after]).toEqual(["new-ledger", undefined, undefined, "changed", undefined])
  })
})

describe("SDK：assembleSdkWorkerTurnPrompt 的 hostPrompt", () => {
  // 每轮信封里有「现在」，几次拼装要逐字比较，时间得固定住
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 25, 10, 19)) })
  afterEach(() => { vi.useRealTimers() })

  const HOST = "# 身份\n\n宿主提示词-XYZ"

  it("给了：放在信封之前，前后各隔一个空行，且只出现一次", () => {
    const p = assembleSdkWorkerTurnPrompt(MSGS, CTX, { hostPrompt: HOST })
    expect(p.startsWith(`${HOST}\n\n<turn `)).toBe(true)
    expect(p.indexOf(HOST)).toBeLessThan(p.indexOf(USER_TEXT))
    expect(p.split(HOST).length - 1).toBe(1)
  })

  it("没给（后面轮次的常态）：只有信封，没有任何宿主提示词的痕迹", () => {
    const p = assembleSdkWorkerTurnPrompt(MSGS, CTX)
    expect(p.startsWith("<turn ")).toBe(true)
    expect(p).not.toContain("# 身份")
    expect(p).toContain(USER_TEXT)
  })

  it("给空串和不给一样（不会多出空段）", () => {
    expect(assembleSdkWorkerTurnPrompt(MSGS, CTX, { hostPrompt: "" })).toBe(assembleSdkWorkerTurnPrompt(MSGS, CTX))
  })

  it("给不给宿主提示词，信封部分一字不差（宿主提示词是纯插入）", () => {
    const without = assembleSdkWorkerTurnPrompt(MSGS, CTX)
    const withHost = assembleSdkWorkerTurnPrompt(MSGS, CTX, { hostPrompt: HOST })
    expect(withHost.replace(`${HOST}\n\n`, "")).toBe(without)
  })
})

describe("Pi：buildAppendSystemPrompt 放同一份宿主提示词", () => {
  const launch = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true } as never

  it("整份放进系统提示词，仍是一个字符串块；有名单就带名单", () => {
    withCatalog(CATALOG)
    const blocks = buildAppendSystemPrompt(launch)
    expect(blocks).toEqual([buildHostPrompt(CTX).text])
    expect(blocks[0]).toContain(CATALOG)
  })

  it("没有名单：只有协议", () => {
    const blocks = buildAppendSystemPrompt(launch)
    expect(blocks).toEqual([joinPromptBlocks(assembleProtocolBlocks(CTX))])
    expect(blocks[0]).not.toContain("本机有下面这些 Skill")
  })

  it("两个引擎给 AI 看的是同一份文本：Pi 的系统提示词 = SDK 新账本第一轮给的整份", () => {
    withCatalog(CATALOG)
    expect(buildAppendSystemPrompt(launch)[0]).toBe(planHostPrompt(CTX, undefined)!.text)
  })
})

describe("Pi 自带的 Skill 清单确实关了（用真实的 Pi ResourceLoader 验证）", () => {
  let tmp: string

  function makeSkill(dir: string, name: string): void {
    fs.mkdirSync(path.join(dir, name), { recursive: true })
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n正文\n`)
  }

  async function loadSkills(extra: object): Promise<string[]> {
    const cwd = path.join(tmp, "work")
    const agentDir = path.join(tmp, "agent")
    makeSkill(path.join(agentDir, "skills"), "from-agent-dir") // Pi 默认会扫 agentDir/skills
    makeSkill(path.join(cwd, ".pi", "skills"), "from-project-pi") // 项目级 .pi/skills
    makeSkill(path.join(cwd, ".agents", "skills"), "from-project-agents") // 项目级 .agents/skills
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      appendSystemPrompt: ["x"],
      ...extra,
    })
    await loader.reload()
    return loader.getSkills().skills.map((s) => s.name).sort()
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-noskills-"))
    return () => fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("对照组：不关的话 Pi 会自己扫到 Skill（说明这个实验看得见 Skill）", async () => {
    const names = await loadSkills({})
    expect(names).toContain("from-agent-dir")
    expect(names).toContain("from-project-pi")
  })

  it("PI_SKILL_LOADING：一个 Skill 都不加载，也就不会生成 Pi 自己的 <available_skills>", async () => {
    expect(await loadSkills({ ...PI_SKILL_LOADING })).toEqual([])
  })
})
