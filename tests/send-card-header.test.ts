/**
 * send_text / send_question 发到飞书的卡片头部（daemon 里真实的 resolveSendCardHeader，配真实的项目存储）。
 *
 * 现场：周报任务的结果通知到飞书私聊，头部却是「📦 排课系统慢sql治理 / 🌿 feature/…」。
 * 任务结果的出站目标是聊天键、不带会话，头部就借了这个聊天当前的活跃会话；
 * 而私聊的活跃会话停在一个早已归档的项目上。
 * 这里锁住：独立任务的头部只认任务自己；不是任务的发送，头部取法和以前一样。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { activeSessionMap, resolveSendCardHeader, resolveSendCardText } from "../src/daemon.js"
import { createProject, initProjectStore, setProjectArchived } from "../src/shared/project-store.js"
import { projectSessionKey, type Project } from "../src/shared/project-types.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import { sessionHeaderTemplate } from "../src/shared/session-label.js"
import { TASK_MISSING_RESULT_BODY, formatTaskImMessage } from "../src/shared/task-delivery.js"

const CHANNEL = "ch_hdr_test"
const MAIN = "oc_main_hdr"
const GROUP = "oc_group_hdr"
const CHAT = `${CHANNEL}|${MAIN}`
const TASK_ID = "885824d2-eb4f-4462-812c-ca2b5e9defa9"

type Ch = Parameters<typeof resolveSendCardHeader>[0]
/** 假的飞书通道：只有头部判断用得到的字段（主用户私聊是 MAIN） */
const feishu = (chatId: string): Ch =>
  ({ type: "feishu", chatId, rt: { cfg: { id: CHANNEL, mainUserEnabled: true, mainUserChatId: MAIN } } }) as unknown as Ch

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: TASK_ID, name: "周报编写", cron: "40 8 * * 5", content: "x", enabled: true, independent: true, channelId: CHANNEL, ...over,
})

let dir: string
let wsDir: string
let project: Project
let projectSession: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-card-header-"))
  wsDir = path.join(dir, "my-workspace")
  fs.mkdirSync(wsDir)
  initProjectStore(dir)
  project = createProject({
    name: "排课系统慢sql治理", goal: "g", repoPath: "/r", baseBranch: "main",
    featureBranch: "feature/261110-slow-sql", worktreePath: path.join(dir, "wt"),
  })
  setProjectArchived(project.id, true)
  projectSession = projectSessionKey(CHAT, project.id)
  activeSessionMap.clear()
})

afterEach(() => {
  activeSessionMap.clear()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("独立任务的头部：只认任务自己", () => {
  it("复现现场：私聊停在已归档的项目上，任务结果的头部是任务，不是项目", () => {
    activeSessionMap.set(CHAT, projectSession)
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks: [task()] })
    expect(h.title).toBe("⏰ 周报编写")
    expect(h.colorKey).toBe(TASK_ID)
    expect(h.taskTitled).toBe(true)
  })

  it("私聊停在目录会话上也一样：不会标成「📂 目录名」", () => {
    activeSessionMap.set(CHAT, `${CHAT}::${wsDir}`)
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks: [task()] })
    expect(h.title).toBe("⏰ 周报编写")
  })

  it("配色只由任务决定，不随聊天停在哪个会话变", () => {
    const tasks = [task()]
    activeSessionMap.set(CHAT, projectSession)
    const a = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks })
    activeSessionMap.set(CHAT, `${CHAT}::${wsDir}`)
    const b = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks })
    activeSessionMap.clear()
    const c = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks })
    expect(a.colorKey).toBe(b.colorKey)
    expect(b.colorKey).toBe(c.colorKey)
    expect(sessionHeaderTemplate(a.colorKey)).toBeTruthy()
  })

  it("聊天没有活跃会话时同样有任务头部", () => {
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks: [task()] })
    expect(h.title).toBe("⏰ 周报编写")
  })

  it("发到群聊：和以前一样不露头部（群里不暴露会话信息），配色键仍是任务", () => {
    activeSessionMap.set(`${CHANNEL}|${GROUP}`, projectSessionKey(`${CHANNEL}|${GROUP}`, project.id))
    const h = resolveSendCardHeader(feishu(GROUP), { sessionKey: `${CHANNEL}|${GROUP}`, invokerSessionKey: TASK_ID, tasks: [task()] })
    expect(h.title).toBeUndefined()
    expect(h.colorKey).toBe(TASK_ID)
    expect(h.taskTitled).toBe(false)
  })

  it("没有任务头部的情形：非独立任务照旧按会话取", () => {
    activeSessionMap.set(CHAT, projectSession)
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, invokerSessionKey: TASK_ID, tasks: [task({ independent: false })] })
    expect(h.title).toEqual({ title: "📦 排课系统慢sql治理", subtitle: "🌿 feature/261110-slow-sql" })
    expect(h.colorKey).toBe(projectSession)
    expect(h.taskTitled).toBe(false)
  })
})

/**
 * 任务消息的正文：横幅已经是「⏰ 任务名」时，正文不再写一遍任务名。
 * 现场：飞书私聊里，卡片顶上一条「⏰ 周报编写」，正文第一行又是「⏰ 周报编写」。
 * 这里用 daemon 里真实的头部判断，配 deliverTaskText 实际发出的两份正文（formatTaskImMessage），
 * 看最终发出去的那份：有横幅的只出现一次任务名；没有横幅的（群聊、含 @ 的纯文本消息）任务名留在正文里。
 */
describe("任务消息的正文：横幅有任务名就不再重复", () => {
  const sent = (chatId: string, kind: "result" | "notice", body: string, over: Partial<ScheduledTask> = {}) => {
    const header = resolveSendCardHeader(feishu(chatId), { sessionKey: `${CHANNEL}|${chatId}`, invokerSessionKey: TASK_ID, tasks: [task(over)] })
    const msg = formatTaskImMessage({ name: "周报编写" }, kind, body)
    return { header, text: resolveSendCardText(header, msg.text, msg.titledText) }
  }
  /** 横幅标题 + 正文里，任务名一共出现几次 */
  const nameCount = (s: { header: { title?: unknown }; text: string }) =>
    (JSON.stringify(s.header.title ?? "") + s.text).split("周报编写").length - 1

  it("主用户私聊：横幅显示任务名，正文不带——任务名只出现一次", () => {
    const r = sent(MAIN, "result", "周报已更新")
    expect(r.header.title).toBe("⏰ 周报编写")
    expect(r.text).toBe("周报已更新")
    expect(nameCount(r)).toBe(1)
  })

  it("主用户私聊的兜底提示（没提交结果）也一样", () => {
    const r = sent(MAIN, "notice", TASK_MISSING_RESULT_BODY)
    expect(r.text).toBe("已运行结束，但没有提交结果。")
    expect(nameCount(r)).toBe(1)
  })

  it("群聊没有横幅：任务名留在正文里，收到的人才知道是哪个任务", () => {
    const r = sent(GROUP, "result", "周报已更新")
    expect(r.header.title).toBeUndefined()
    expect(r.text).toBe("⏰ **周报编写**\n\n周报已更新")
    expect(nameCount(r)).toBe(1)
    expect(sent(GROUP, "notice", TASK_MISSING_RESULT_BODY).text).toBe("⏰ **周报编写** 已运行结束，但没有提交结果。")
  })

  it("结果里含 @：发送端会降级成纯文本、没有横幅，任务名必须留在正文里", () => {
    const r = sent(MAIN, "result", '请 <at user_id="ou_x">张三</at> 看一下')
    expect(r.header.title).toBe("⏰ 周报编写") // 头部判断本身没变，是发送端不画
    expect(r.text.startsWith("⏰ **周报编写**\n\n")).toBe(true)
    // @ 写在代码块里不算（发送端也不当 @ 处理），横幅照常显示，正文就不再带任务名
    expect(sent(MAIN, "result", "`<at user_id=\"ou_x\">张三</at>`").text).toBe("`<at user_id=\"ou_x\">张三</at>`")
  })

  it("不是独立任务发出的（没有任务头部）：不管有没有 titledText 都原样用 text", () => {
    const header = resolveSendCardHeader(feishu(MAIN), { sessionKey: projectSession, invokerSessionKey: projectSession, tasks: [task()] })
    expect(header.taskTitled).toBe(false)
    expect(resolveSendCardText(header, "项目会话的回复", "不该被换掉")).toBe("项目会话的回复")
    // 任务已被删（invoker 认不出）：头部退回会话头部，这时也不能把任务名丢掉
    const gone = sent(MAIN, "result", "周报已更新", { id: "another-task" })
    expect(gone.header.taskTitled).toBe(false)
    expect(gone.text).toBe("⏰ **周报编写**\n\n周报已更新")
  })

  it("没带 titledText 或是空白：原样用 text（老调用方、直接 send_text 都不受影响）", () => {
    const header = { taskTitled: true }
    expect(resolveSendCardText(header, "原文")).toBe("原文")
    expect(resolveSendCardText(header, "原文", "")).toBe("原文")
    expect(resolveSendCardText(header, "原文", "   ")).toBe("原文")
    expect(resolveSendCardText(header, "原文", undefined)).toBe("原文")
    expect(resolveSendCardText(header, "原文", 123 as unknown as string)).toBe("原文")
  })
})

describe("不是独立任务的发送：头部取法和以前一样", () => {
  it("项目会话自己回复：头部是该项目（项目名 + 分支）", () => {
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: projectSession, invokerSessionKey: projectSession, tasks: [task()] })
    expect(h.title).toEqual({ title: "📦 排课系统慢sql治理", subtitle: "🌿 feature/261110-slow-sql" })
    expect(h.colorKey).toBe(projectSession)
  })

  it("目录会话自己回复：头部是该目录", () => {
    const sk = `${CHAT}::${wsDir}`
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: sk, invokerSessionKey: sk, tasks: [task()] })
    expect(h.title).toMatchObject({ title: "📂 my-workspace" })
    expect(h.colorKey).toBe(sk)
  })

  it("只给了聊天键（没有会话）：借聊天当前的活跃会话，这一条没变", () => {
    activeSessionMap.set(CHAT, `${CHAT}::${wsDir}`)
    const h = resolveSendCardHeader(feishu(MAIN), { sessionKey: CHAT, tasks: [task()] })
    expect(h.title).toMatchObject({ title: "📂 my-workspace" })
    expect(h.colorKey).toBe(`${CHAT}::${wsDir}`)
  })

  it("发到群聊：不露头部", () => {
    const sk = `${CHANNEL}|${GROUP}::${wsDir}`
    const h = resolveSendCardHeader(feishu(GROUP), { sessionKey: sk, tasks: [task()] })
    expect(h.title).toBeUndefined()
  })
})
