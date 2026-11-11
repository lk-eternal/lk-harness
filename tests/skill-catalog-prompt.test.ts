/**
 * Skill 名单怎么进提示词：
 * - SDK 引擎：assembleSdkWorkerTurnPrompt 在协议块和本轮消息之间插入名单（是否插入由调用方决定）
 * - Pi 引擎：同一份文本放进 appendSystemPrompt，Pi 自己的 Skill 清单关掉
 * 协议模板走真实的，只桩掉 Electron / 配置 / daemon / 名单扫描这些无关依赖。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

const scan = vi.hoisted(() => ({ value: { text: "", hash: "", count: 0 } as { text: string; hash: string; count: number } }))
vi.mock("../electron/skill-catalog", () => ({ getSkillCatalog: () => scan.value }))

import { DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent"
import { assembleProtocolBlocks, assembleSdkWorkerTurnPrompt, clearProtocolTemplateCache, type PromptAssemblyContext } from "../electron/prompt-assembler.js"
import { buildAppendSystemPrompt, PI_SKILL_LOADING } from "../electron/pi-embedded.js"

const CATALOG = "## 本机 Skill\n下面这些目录里有 Skill\n\n### /home/u/.cursor/skills\n- alpha：甲"
const USER_TEXT = "用户这一句-XYZ"
const CTX: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true }
const MSGS = [{ text: USER_TEXT, messageId: "m1" }]

beforeEach(() => {
  clearProtocolTemplateCache()
  scan.value = { text: "", hash: "", count: 0 }
})

describe("SDK：assembleSdkWorkerTurnPrompt 的 skillCatalog", () => {
  it("给了名单：放在协议块之后、本轮消息之前，且只出现一次", () => {
    const protocol = assembleProtocolBlocks(CTX).join("\n")
    const p = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true, skillCatalog: CATALOG })
    const at = p.indexOf(CATALOG)
    expect(at).toBeGreaterThanOrEqual(protocol.length)
    expect(at).toBeLessThan(p.indexOf(USER_TEXT))
    expect(p.split(CATALOG).length - 1).toBe(1)
  })

  it("名单和前后都用 --- 隔开，和协议块、消息不粘在一起", () => {
    const p = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true, skillCatalog: CATALOG })
    expect(p).toContain(`\n---\n${CATALOG}\n---\n`)
  })

  it("没给名单（后续轮次的常态）：提示词里没有任何 Skill 名单痕迹，也没有多余的分隔线", () => {
    const p = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: false })
    expect(p).not.toContain("本机 Skill")
    expect(p).not.toContain("---\n---")
    expect(p).toContain(USER_TEXT)
  })

  it("给空串和不给一样（不会多出一对空的分隔线）", () => {
    const none = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true })
    const empty = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true, skillCatalog: "" })
    expect(empty).toBe(none)
  })

  it("带不带名单，其余部分一字不差（名单是纯插入，不改动协议和消息）", () => {
    const without = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true })
    const withCat = assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true, skillCatalog: CATALOG })
    expect(withCat.replace(`---\n${CATALOG}\n`, "")).toBe(without)
  })
})

describe("Pi：buildAppendSystemPrompt 带上同一份名单", () => {
  const launch = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true } as never

  it("有名单：协议块之后接 --- 和名单，整体仍是一个字符串块", () => {
    scan.value = { text: CATALOG, hash: "abc", count: 1 }
    const blocks = buildAppendSystemPrompt(launch)
    expect(blocks).toHaveLength(1)
    const protocol = assembleProtocolBlocks(CTX).join("\n")
    expect(blocks[0].startsWith(protocol)).toBe(true)
    expect(blocks[0].endsWith(`\n---\n${CATALOG}`)).toBe(true)
  })

  it("没有名单：只有协议，不留尾部的 ---", () => {
    const blocks = buildAppendSystemPrompt(launch)
    expect(blocks).toEqual([assembleProtocolBlocks(CTX).join("\n")])
    expect(blocks[0]).not.toContain("本机 Skill")
  })

  it("两个引擎给 AI 看的名单是同一份文本", () => {
    scan.value = { text: CATALOG, hash: "abc", count: 1 }
    expect(buildAppendSystemPrompt(launch)[0]).toContain(CATALOG)
    expect(assembleSdkWorkerTurnPrompt(MSGS, CTX, { firstTurn: true, skillCatalog: scan.value.text })).toContain(CATALOG)
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
