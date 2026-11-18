import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { COMMANDS } from "../src/shared/command-catalog"
import { PROJECT_RESERVED_SUBCOMMANDS } from "../src/shared/project-types"
import { buildProjectHelp } from "../src/shared/project-ai-help"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { makeChatKey } from "../src/shared/channel-types"
import {
  buildEmptyProjectMenu,
  buildHelpBodyForAdmin,
  buildHelpButtons,
  buildWelcomeCard,
  type GuideButton,
} from "../src/shared/quick-start"

/**
 * 飞书 / 微信里的「快速上手」：新用户不知道能干什么、怎么建项目、先要配什么。
 * 三处共用一份说法：主用户绑定成功后的欢迎卡、/help、还没有项目时的 /p。
 * 守住：按钮指令都是真实存在的、文字里提到的按钮名和按钮对得上、非主用户的 /help 不变、
 * 欢迎卡真的走 daemon 发到主用户私聊、空项目的 /p 走真实的指令处理，以及接线没丢。
 */

let userData = ""
let disk: Record<string, unknown> = {}
vi.mock("electron-store", () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      disk = structuredClone(opts.defaults ?? {})
    }
    get store() { return disk }
    set(patch: Record<string, unknown>) { Object.assign(disk, structuredClone(patch)) }
  },
}))
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { trashItem: async () => {} },
  dialog: {},
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const cmdHead = (cmd: string) => cmd.trim().split(/\s+/)[0]
const cmds = (buttons: GuideButton[]) => buttons.map((b) => b.cmd)

/** 按钮指令的第一个词必须是 daemon 认的指令；/p 的子指令必须是 /p 处理的 */
function expectRealCommands(buttons: GuideButton[]) {
  for (const b of buttons) {
    expect(Object.keys(COMMANDS), `${b.label} → ${b.cmd}`).toContain(cmdHead(b.cmd))
    const parts = b.cmd.trim().split(/\s+/)
    if (parts[0] === "/p" && parts[1]) expect(PROJECT_RESERVED_SUBCOMMANDS, b.cmd).toContain(parts[1])
  }
}

describe("欢迎卡", () => {
  const card = buildWelcomeCard()

  it("讲清三件事：能干什么、项目是什么、要不要先配东西", () => {
    expect(card.text).toContain("直接发消息给我")
    expect(card.text).toContain("项目")
    expect(card.text).toContain("帮我建个项目")
    expect(card.text).toContain("不接代码仓库的模板什么都不用先配")
    expect(card.text).toContain("/help")
  })

  it("自然语言优先：先教怎么说（建项目、配仓库、看配置、改模板），指令只在最后兜底", () => {
    expect(card.text).toContain("不用记指令")
    for (const phrase of ["「帮我建个项目」", "「把 D:/code/demo 加到常用仓库」", "「看看项目现在都配了什么」", "「把开发模板的审查步骤改成……」"]) {
      expect(card.text, phrase).toContain(phrase)
    }
    // 用户要发的是话，不是要敲的指令：正文里不再让人去敲 /p new、/p setup
    expect(card.text).not.toContain("/p new")
    expect(card.text).not.toContain("/p setup")
    // 示例话术排在「点按钮」备选之前
    expect(card.text.indexOf("帮我建个项目")).toBeLessThan(card.text.indexOf("不想打字"))
  })

  it("话术说的事 AI 真能办：对应的 manage_project 手册里有这些能力", () => {
    const all = ["overview", "create", "repos", "templates", "settings", "manage"].map((t) => buildProjectHelp(t).text).join("\n")
    // 建项目 / 加常用仓库 / 看配置 / 改模板，各有对应的 action
    for (const word of ["「帮我建个项目」", "常用仓库", "repo_save", "action=settings", "settings_set", "template_save"]) expect(all, word).toContain(word)
  })

  it("按钮：新建项目、我的项目、配置仓库/目录、全部指令，指令都真实存在", () => {
    expect(cmds(card.buttons)).toEqual(["/p new", "/p", "/p setup", "/h"])
    expectRealCommands(card.buttons)
  })

  it("文字里点名的按钮，卡上真的有（不会写了「点新建项目」却没有这个按钮）", () => {
    const labels = card.buttons.map((b) => b.label)
    for (const name of ["新建项目", "配置仓库/目录"]) {
      expect(card.text).toContain(`「${name}」`)
      expect(labels.some((l) => l.includes(name)), name).toBe(true)
    }
  })

  it("按钮分组：项目三个一组，更多单独一组（飞书按组插标题，微信按组分段）", () => {
    expect(card.buttons.map((b) => b.section)).toEqual(["▶ 项目", "▶ 项目", "▶ 项目", "▶ 更多"])
  })

  it("有卡片标题", () => {
    expect(card.title).toEqual({ title: "快速上手", subtitle: "欢迎" })
  })
})

describe("/help", () => {
  it("主用户：原来的四组按钮都在，协作组里多一个「新建项目」，指令都真实存在", () => {
    const btns = buildHelpButtons(true)
    expect(cmds(btns)).toEqual(["/s", "/x", "/r", "/m", "/ls", "/cl", "/c", "/t", "/p", "/p new", "/mc", "/rr"])
    expect(btns.find((b) => b.cmd === "/p new")).toMatchObject({ label: "🆕 新建项目", section: "▶ 协作" })
    expectRealCommands(btns)
  })

  it("非主用户：只有状态、停止、重置，和以前一样", () => {
    expect(cmds(buildHelpButtons(false))).toEqual(["/s", "/x", "/r"])
  })

  it("主用户的正文指向建项目；文字里点名的按钮在按钮里", () => {
    const body = buildHelpBodyForAdmin()
    expect(body).toContain("帮我建个项目")
    expect(body).toContain("「🆕 新建项目」")
    expect(buildHelpButtons(true).map((b) => b.label)).toContain("🆕 新建项目")
  })

  it("主用户的正文以「大白话 / 不用记指令」开头，并给配仓库的说法", () => {
    const body = buildHelpBodyForAdmin()
    expect(body.split("\n")[0]).toContain("不用记指令")
    expect(body).toContain("加到常用仓库")
    expect(body).not.toContain("发送指令")
  })

  it("正文比欢迎卡短（每次打开 /help 都看，不能太长）", () => {
    expect(buildHelpBodyForAdmin().length).toBeLessThan(buildWelcomeCard().text.length / 2)
  })
})

describe("还没有项目时的 /p 内容", () => {
  const menu = buildEmptyProjectMenu()

  it("先说没有项目，再讲项目是什么、怎么建；不再是一串子指令", () => {
    expect(menu.text.startsWith("📭 还没有项目")).toBe(true)
    expect(menu.text).toContain("帮我建个项目")
    expect(menu.text).toContain("加到常用仓库")
    expect(menu.text).not.toContain("/p plan")
    expect(menu.text).not.toContain("/p use")
  })

  it("按钮：新建项目、配置仓库/目录、指令说明（子指令说明还能看到）", () => {
    expect(cmds(menu.buttons)).toEqual(["/p new", "/p setup", "/p help"])
    expectRealCommands(menu.buttons)
    expect(menu.title).toEqual({ title: "项目", subtitle: "菜单" })
  })
})

// ── 接真实的发送和指令处理 ──────────────────────────────────────────────────

type Hit = { url: string; body: Record<string, any> }
let hits: Hit[] = []
let server: http.Server
let port = 0

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "quick-start-"))
  hits = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      let body: Record<string, any> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* 空体 */ }
      hits.push({ url: req.url ?? "", body })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = (server.address() as { port: number }).port
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
})

const results = () => hits.filter((h) => h.url === "/cmd/result")

describe("绑定成功后发欢迎卡（真实发送，假 daemon）", () => {
  it("直发到主用户私聊：没有消息号、带通道前缀的聊天键、欢迎卡的文字按钮标题", async () => {
    vi.resetModules()
    const { sendWelcomeCard } = await import("../electron/quick-start-card")
    await sendWelcomeCard(port, "ch_fs", "ou_main")

    expect(results()).toHaveLength(1)
    const body = results()[0].body
    const card = buildWelcomeCard()
    expect(body).toMatchObject({
      messageId: "",
      ok: true,
      chatId: makeChatKey("ch_fs", "ou_main"),
      message: card.text,
      buttons: card.buttons,
      cardTitle: card.title,
    })
  })

  it("微信一样：daemon 回报的是原始聊天号，这里补上通道前缀", async () => {
    vi.resetModules()
    const { sendWelcomeCard } = await import("../electron/quick-start-card")
    await sendWelcomeCard(port, "ch_wx", "wxid_abc")
    expect(results()[0].body.chatId).toBe("ch_wx|wxid_abc")
  })

  it("聊天号已经带通道前缀就原样用，不会变成 ch_fs|ch_fs|…", async () => {
    vi.resetModules()
    const { sendWelcomeCard } = await import("../electron/quick-start-card")
    await sendWelcomeCard(port, "ch_fs", "ch_fs|ou_main")
    expect(results()[0].body.chatId).toBe("ch_fs|ou_main")
  })

  it("daemon 不在了也不抛错（只是发不出去，绑定本身不受影响）", async () => {
    vi.resetModules()
    const { sendWelcomeCard } = await import("../electron/quick-start-card")
    // 一个刚关掉的端口：没有任何东西在听
    const gone = http.createServer()
    await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r))
    const deadPort = (gone.address() as { port: number }).port
    await new Promise<void>((r) => gone.close(() => r()))
    await expect(sendWelcomeCard(deadPort, "ch_fs", "ou_main")).resolves.toBeUndefined()
    expect(results()).toEqual([])
  })
})

describe("/p 没有项目时（真实指令处理）", () => {
  async function boot() {
    vi.resetModules()
    const config = await import("../electron/config-store")
    config.saveConfig({
      channels: [{
        id: "ch_fs", name: "fs", enabled: true, type: "feishu", agentResourceId: "sdk_t", model: "auto", modelParams: "",
        othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
        mainUserEnabled: true, mainUserChatId: "ou_main",
      }] as never,
      agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
      favWorkspacesMigrated: true,
    })
    const store = await import("../src/shared/project-store")
    store.initProjectStore(userData)
    const commands = await import("../electron/project-commands")
    return { store, commands }
  }
  const CHAT = makeChatKey("ch_fs", "ou_main")

  it("发的是「项目是什么、怎么建」的卡，按钮是新建项目 / 配置仓库/目录 / 指令说明", async () => {
    const { commands } = await boot()
    await commands.handleFeishuProjectCommand(port, "m1", "/p", CHAT)

    expect(results()).toHaveLength(1)
    const empty = buildEmptyProjectMenu()
    expect(results()[0].body).toMatchObject({
      messageId: "m1", ok: true, chatId: CHAT,
      message: empty.text, buttons: empty.buttons, cardTitle: empty.title,
    })
  })

  it("「指令说明」按钮（/p help）仍能看到子指令清单", async () => {
    const { commands } = await boot()
    await commands.handleFeishuProjectCommand(port, "m1", "/p help", CHAT)
    expect(results()[0].body.message).toContain("/p new — 新建项目")
    expect(results()[0].body.message).toContain("/p setup")
  })

  it("对照：已经有项目时，/p 还是原来的项目菜单，不是空状态", async () => {
    const { store, commands } = await boot()
    store.createProject({
      name: "已有的", goal: "", worktreePath: path.join(userData, "ws", "workspace"), groupIds: ["general"], groupId: "general",
      bindings: [{ kind: "main", channelId: "ch_fs" }],
    })
    await commands.handleFeishuProjectCommand(port, "m1", "/p", CHAT)
    const body = results()[0].body
    expect(body.message).toContain("📦 项目菜单")
    expect(body.message).toContain("已有的")
    expect(body.message).not.toContain("还没有项目")
  })

  it("别的通道的项目不算：这个通道里 /p 还是空状态（集中部署时不会看到别人的项目）", async () => {
    const { store, commands } = await boot()
    store.createProject({
      name: "别人的", goal: "", worktreePath: path.join(userData, "ws", "workspace"), groupIds: ["general"], groupId: "general",
      bindings: [{ kind: "main", channelId: "ch_other" }],
    })
    await commands.handleFeishuProjectCommand(port, "m1", "/p", CHAT)
    const empty = buildEmptyProjectMenu()
    expect(results()[0].body).toMatchObject({ message: empty.text })
    expect(results()[0].body.message).not.toContain("别人的")
  })
})

// ── 接线：改了模块没接上，没人会发现 ────────────────────────────────────────

describe("接线", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "daemon-manager.ts"), "utf-8").replace(/\r\n/g, "\n")

  it("绑定成功（不是只补记 openId）才发欢迎卡", () => {
    const start = src.indexOf('line.startsWith("__BIND_RESULT__:")')
    const end = src.indexOf('line.startsWith("__WORKSPACE_SWITCH__:")')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    const fillOnlyBranch = block.indexOf("if (!fillOnly) {")
    const sendAt = block.indexOf("sendWelcomeCard(")
    expect(fillOnlyBranch).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(fillOnlyBranch)
    // 只出现一次：补记 openId 的静默回写不会发卡
    expect(block.match(/sendWelcomeCard\(/g)).toHaveLength(1)
  })

  it("/help 用共用的按钮和正文；非主用户保留原来的正文", () => {
    const start = src.indexOf('case "/help": {')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf("default:", start))
    expect(block).toContain("buildHelpButtons(isAdmin)")
    expect(block).toContain("isAdmin")
    expect(block).toContain("buildHelpBodyForAdmin()")
    expect(block).toContain("💡 点下面按钮或直接发送指令；有下级选项的会先说明用法")
  })
})
