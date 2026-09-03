import { randomUUID } from "node:crypto"
import {
  getConfig, getAgentResource, updateChannel,
  resolveChannelForSession, effectiveWorkspaceDir, type MessageChannel, type ScheduledTask,
} from "./config-store"
import { validateCron, readTasksFromFile, writeTasksToFile, previewCronNextRuns, getNextCronFireLabel } from "./cron-scheduler"
import { broadcastLog } from "./ui-logger"
import {
  getAgentEngine,
  findLiveSessionKey,
  switchAgentSessionModel,
  isAgentSessionRunningOrResumable,
} from "./agent-engine"
import { listQuickModels, getSessionOverride, type ModelEntry } from "../src/shared/session-model-store.js"
import { resolveModelLabel, rememberModelLabel } from "../src/shared/model-utils.js"
import { McpServerEntry, getMcpServerList, getMcpEnabledMap, toggleMcpServer, deleteMcpServer, saveMcpServer } from "./mcp-manager"
import { httpPost, getCurrentActiveSession, enqueueToMainSession } from "./daemon-client"

// ── 共享类型与工具 ─────────────────────────────────────────

export interface FileCommand { id: string; command: string; messageId: string; chatId?: string; chatType?: string; fromCard?: boolean; senderOpenId?: string }

export interface CommandButton { label: string; cmd: string; /** 分组标题（飞书插在按钮前，微信列表分段） */ section?: string }

export type CommandCardSection = { text: string; buttons?: CommandButton[] }

export type CommandResultExtra = {
  cardTitle?: { title: string; subtitle?: string }
  sections?: CommandCardSection[]
  /** 出站消息登记到此会话：用户引用该消息回复可路由回原会话 */
  sessionKey?: string
  /** 原卡更新：patch 该卡片替代新发消息（仅飞书按钮点击场景；失败自动回退新发） */
  patchMessageId?: string
}

function cmdCardExtra(patchMessageId?: string, title?: string, subtitle?: string): CommandResultExtra | undefined {
  const extra: CommandResultExtra = {}
  if (patchMessageId) extra.patchMessageId = patchMessageId
  if (title) extra.cardTitle = { title, subtitle }
  return Object.keys(extra).length ? extra : undefined
}

function helpNavButton(): CommandButton {
  return { label: "← 帮助", cmd: "/h", section: "导航" }
}

function withNav(buttons: CommandButton[], patchMessageId?: string): CommandButton[] {
  return patchMessageId ? [...buttons, helpNavButton()] : buttons
}

export async function reportCommandResult(
  port: number,
  messageId: string,
  ok: boolean,
  message: string,
  chatId?: string,
  buttons?: CommandButton[],
  extra?: CommandResultExtra,
): Promise<void> {
  try {
    // daemon 端要等飞书 API 发送完成才应答，默认 3s 超时会把慢请求误判失败，
    // 用户就永远停在「正在处理…」卡片上（如建项结果卡）
    await httpPost(`http://127.0.0.1:${port}/cmd/result`, {
      messageId, ok, message, chatId, buttons,
      cardTitle: extra?.cardTitle,
      sections: extra?.sections,
      sessionKey: extra?.sessionKey,
      patchMessageId: extra?.patchMessageId,
    }, 20000)
  } catch (e: unknown) {
    broadcastLog(`指令结果回报失败: ${e instanceof Error ? e.message : e}`, "WARN")
  }
}


// ── Model 命令 ─────────────────────────────────────────────

export type ListedModel = { id: string; label: string; current: boolean; params?: string }

async function listModelsForCommands(channel: MessageChannel): Promise<{ ok: true; models: ListedModel[] } | { ok: false; error: string }> {
  const resource = getAgentResource(channel.agentResourceId)
  if (!resource) return { ok: false, error: "未配置 Agent 资源" }
  const r = await getAgentEngine(resource).listModels?.(resource, channel, channel.model, channel.modelParams)
  if (!r?.ok) return { ok: false, error: r?.error || "获取模型列表失败" }
  const models = (r.models ?? []).map((m) => ({ id: m.id, label: m.label, current: !!m.current }))
  if (models.length === 0) return { ok: false, error: "暂无可用模型" }
  return { ok: true, models }
}

const MODEL_SUBCMD_HELP = [
  "💡 /m 模型指令",
  "🔹 /m ls — 查看可选模型",
  "🔹 /m info — 查看当前对话在用的模型",
  "🔹 /m set <序号> — 切换当前对话的模型",
  "🔹 /m use <序号|id> — 同 set",
].join("\n")

async function resolveModelSessionKey(port: number, chatId?: string, channel?: MessageChannel): Promise<string | undefined> {
  if (!chatId) return undefined
  // 活跃路由优先：用户在项目/目录会话里切模型，必须落在正聊的那个会话上
  const active = await getCurrentActiveSession(port, chatId)
  if (active?.trim()) return active
  const live = findLiveSessionKey(chatId)
  if (live) return live
  const ws = effectiveWorkspaceDir(channel)
  return ws ? `${chatId}::${ws}` : chatId
}

async function applySessionModelPick(
  port: number,
  messageId: string,
  channel: MessageChannel,
  chatId: string | undefined,
  picked: ListedModel,
  idxLabel?: string,
  patchMessageId?: string,
): Promise<void> {
  const sessionKey = await resolveModelSessionKey(port, chatId, channel)
  if (!sessionKey) {
    await reportCommandResult(port, messageId, false, "❌ 无法解析会话（缺少 chatId）", chatId, undefined, cmdCardExtra(patchMessageId, "模型"))
    return
  }
  const resource = getAgentResource(channel.agentResourceId)
  const r = resource
    ? await switchAgentSessionModel(resource, sessionKey, picked.id, picked.params ?? "")
    : { ok: false, error: "未配置 Agent 资源" }
  if (!r.ok) {
    await reportCommandResult(port, messageId, false, `❌ 切换失败: ${r.error}`, chatId, undefined, cmdCardExtra(patchMessageId, "模型"))
    return
  }
  const display = resolveModelLabel(picked.id, picked.params, picked.label) || picked.id
  if (picked.label) rememberModelLabel(picked.id, picked.params, picked.label)
  const lines = [
    `✅ 已切换模型（有排队消息时自动拉起）`,
    idxLabel ? ` # · ${idxLabel}` : undefined,
    `🧠 ${display}`,
    `应用默认模型未改：${resolveModelLabel(channel.model, channel.modelParams) || channel.model?.trim() || "auto"}`,
  ].filter(Boolean) as string[]
  await reportCommandResult(port, messageId, true, lines.join("\n"), chatId, undefined, cmdCardExtra(patchMessageId, "模型", "已切换"))
}

/**
 * 常用模型（favoriteModels）是全局列表，历史上混着 Cursor SDK / 其他网关的模型。
 * /m 只列当前通道 Agent 能用的那些，否则点 q# 必定切换失败。
 */
async function quickModelsForChannel(channel: Parameters<typeof listModelsForCommands>[0]): Promise<ModelEntry[]> {
  const favs = (getConfig().favoriteModels ?? []) as ModelEntry[]
  const lr = await listModelsForCommands(channel)
  if (!lr.ok) return favs
  const usable = new Set(lr.models.map((m) => m.id.toLowerCase()))
  return favs.filter((f) => usable.has(f.model.toLowerCase()))
}

export async function handleFeishuModelCommand(port: number, messageId: string, raw: string, chatId?: string, patchMessageId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()
  const mExtra = (subtitle?: string) => cmdCardExtra(patchMessageId, "模型", subtitle)

  const channel = chatId ? resolveChannelForSession(chatId) : undefined
  if (!channel) {
    await reportCommandResult(port, messageId, false, "❌ 未找到当前会话所属的消息通道", chatId, undefined, mExtra())
    return
  }

  if (parts.length <= 1) {
    const quick = listQuickModels(await quickModelsForChannel(channel), 6)
    const subBtns = withNav([
      { label: "📋 模型列表", cmd: "/m ls" },
      { label: "ℹ️ 当前模型", cmd: "/m info" },
    ], patchMessageId)
    const favBtns = quick.map((m, i) => {
      const slug = resolveModelLabel(m.model, m.modelParams, m.label) || m.model
      return { label: `⚡ ${slug}`.slice(0, 40), cmd: `/m use q${i + 1}` }
    })
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP, chatId, [...subBtns, ...favBtns], mExtra("菜单"))
    return
  }

  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") {
    await reportCommandResult(port, messageId, true, MODEL_SUBCMD_HELP, chatId, withNav([
      { label: "📋 模型列表", cmd: "/m ls" },
      { label: "ℹ️ 当前模型", cmd: "/m info" },
    ], patchMessageId), mExtra("菜单"))
    return
  }

  if (sub === "info") {
    const sessionKey = await resolveModelSessionKey(port, chatId, channel)
    const resource = getAgentResource(channel.agentResourceId)
    const cfgDisplay = resolveModelLabel(channel.model, channel.modelParams) || channel.model?.trim() || "auto"
    const ov = sessionKey ? getSessionOverride(sessionKey) : undefined
    const ovDisplay = ov ? resolveModelLabel(ov.model, ov.modelParams) : undefined
    const lines: string[] = [
      `📝 「${channel.name}」默认模型: ${cfgDisplay}`,
      ovDisplay ? `当前对话模型: ${ovDisplay}` : "当前对话模型: （同默认）",
      sessionKey && resource && isAgentSessionRunningOrResumable(sessionKey, resource)
        ? "状态: 进行中"
        : "状态: 空闲（切换模型将在下次对话生效）",
    ]
    await reportCommandResult(port, messageId, true, lines.join("\n"), chatId, withNav([
      { label: "📋 模型列表", cmd: "/m ls" },
    ], patchMessageId), mExtra("当前"))
    return
  }

  if (sub === "ls") {
    const lr = await listModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`, chatId, undefined, mExtra())
      return
    }
    const blocks = lr.models.map((m, i) => {
      const n = i + 1
      const tag = m.current ? "  ⭐current" : ""
      const display = resolveModelLabel(m.id, m.params, m.label) || m.label || m.id
      return `#${n}  ${display}${tag}`
    })
    const body = [`🧠 模型列表（共 ${lr.models.length} 个）`, "", ...blocks, "", "💡 点下方按钮切换，或 /m set <序号>"].join("\n")
    const btns = withNav(lr.models.slice(0, 6).map((m, i) => {
      const display = resolveModelLabel(m.id, m.params, m.label) || m.label || m.id
      return { label: `#${i + 1} ${display}`.slice(0, 40), cmd: `/m set ${i + 1}`, section: "切换模型" }
    }), patchMessageId)
    await reportCommandResult(port, messageId, true, body, chatId, btns, mExtra("列表"))
    return
  }

  if (sub === "set" || sub === "use") {
    if (parts.length < 3) {
      await reportCommandResult(port, messageId, false, `💡 用法：/m ${sub} <序号|id|qN>`, chatId, undefined, mExtra())
      return
    }
    const token = parts[2]
    const qMatch = /^q(\d+)$/i.exec(token)
    if (qMatch) {
      const quick = listQuickModels(await quickModelsForChannel(channel), 20)
      const qi = parseInt(qMatch[1], 10)
      if (qi < 1 || qi > quick.length) {
        await reportCommandResult(port, messageId, false, `😅 常用模型序号须为 1～${quick.length}（先 /m）`, chatId, undefined, mExtra())
        return
      }
      const fromQuick = quick[qi - 1]
      const picked: ListedModel = {
        id: fromQuick.model,
        label: resolveModelLabel(fromQuick.model, fromQuick.modelParams, fromQuick.label) || fromQuick.model,
        current: false,
        params: fromQuick.modelParams,
      }
      await applySessionModelPick(port, messageId, channel, chatId, picked, `q${qi}`, patchMessageId)
      return
    }
    const lr = await listModelsForCommands(channel)
    if (!lr.ok) {
      await reportCommandResult(port, messageId, false, `❌ ${lr.error}`, chatId, undefined, mExtra())
      return
    }
    const idx = parseInt(token, 10)
    let picked: ListedModel | undefined
    let idxLabel: string | undefined
    if (Number.isInteger(idx) && idx >= 1 && String(idx) === token) {
      if (idx > lr.models.length) {
        await reportCommandResult(port, messageId, false, `😅 序号须为 1～${lr.models.length} 之间的整数（先 /m ls）`, chatId, undefined, mExtra())
        return
      }
      picked = lr.models[idx - 1]
      idxLabel = String(idx)
    } else {
      picked = lr.models.find((m) => {
        const slug = resolveModelLabel(m.id, m.params, m.label)
        return m.id === token || m.id.startsWith(token) || slug === token || m.label === token
      })
      if (!picked) {
        const fromQuick = listQuickModels(await quickModelsForChannel(channel), 20).find((m) => {
          const slug = resolveModelLabel(m.model, m.modelParams, m.label) || m.model
          return m.model === token || slug === token
        })
        if (fromQuick) {
          picked = {
            id: fromQuick.model,
            label: resolveModelLabel(fromQuick.model, fromQuick.modelParams, fromQuick.label) || fromQuick.model,
            current: false,
            params: fromQuick.modelParams,
          }
        }
      }
      if (!picked) {
        await reportCommandResult(port, messageId, false, `😅 未找到模型: ${token}（先 /m ls）`, chatId, undefined, mExtra())
        return
      }
    }
    const pIdx = parts.indexOf("--params")
    if (pIdx >= 0 && parts[pIdx + 1] !== undefined) {
      picked = { ...picked, params: parts.slice(pIdx + 1).join(" ") }
    } else if (!picked.params) {
      const hit = listQuickModels(await quickModelsForChannel(channel), 20).find((m) => m.model === picked!.id)
      if (hit?.modelParams) picked = { ...picked, params: hit.modelParams }
    }
    await applySessionModelPick(port, messageId, channel, chatId, picked, idxLabel, patchMessageId)
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知指令: ${parts[1]}\n\n${MODEL_SUBCMD_HELP}`, chatId, undefined, mExtra())
}

// ── Task 命令 ──────────────────────────────────────────────

const TASK_SUBCMD_HELP = [
  "💡 /t 定时任务",
  "🔹 /t ls — 列出任务",
  "🔹 /t info <序号> — 查看任务详情",
  "🔹 /t run <序号> — 立即执行一次",
  "🔹 /t stop <序号> — 暂停任务",
  "🔹 /t start <序号> — 启用任务",
  "🔹 /t delete <序号> — 删除任务",
  "🔹 /t create <名称> <cron> <内容> — 新建任务",
  "🔹 /t update <序号> … — 修改任务",
].join("\n")

function parseTaskOneBasedIndex(s: string | undefined): number | null {
  if (s === undefined || s === "") return null
  const n = parseInt(s, 10)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

function parseTaskCreateArgs(parts: string[]):
  | { ok: true; name: string; cron: string; content: string }
  | { ok: false; error: string } {
  const afterCreate = parts.slice(2)
  if (afterCreate.length < 1 + 5 + 1) {
    return { ok: false, error: "❌ 参数不足：/t create <名称> <cron五或六段> <内容>" }
  }
  for (const cronLen of [6, 5] as const) {
    if (afterCreate.length < cronLen + 2) continue
    for (let nameLen = 1; nameLen <= afterCreate.length - cronLen - 1; nameLen++) {
      const name = afterCreate.slice(0, nameLen).join(" ").trim()
      if (!name) continue
      const cronToks = afterCreate.slice(nameLen, nameLen + cronLen)
      const cronExpr = cronToks.join(" ").trim()
      if (!validateCron(cronExpr)) continue
      const content = afterCreate.slice(nameLen + cronLen).join(" ").trim()
      if (!content) return { ok: false, error: "任务内容不能为空" }
      return { ok: true, name, cron: cronExpr, content }
    }
  }
  return { ok: false, error: "无法解析：请保证「名称」「cron（连续 5 或 6 段）」「内容」三部分，且 cron 能通过校验" }
}

function parseTaskUpdateArgs(parts: string[]):
  | { ok: true; oneBasedIndex: number; updates: { name?: string; cron?: string; content?: string } }
  | { ok: false; error: string } {
  if (parts.length < 4) {
    return { ok: false, error: "💡 用法：/t update <序号> [-name 值] [-cron 值] [-content 值]" }
  }
  const idx = parseTaskOneBasedIndex(parts[2])
  if (idx === null) return { ok: false, error: "❌ 序号须为正整数" }
  const known = new Set(["-name", "-cron", "-content"])
  let i = 3
  const updates: { name?: string; cron?: string; content?: string } = {}
  while (i < parts.length) {
    const flag = parts[i].toLowerCase()
    if (!known.has(flag)) {
      return { ok: false, error: `❌ 未知选项: ${parts[i]}（仅支持 -name -cron -content）` }
    }
    i++
    const valBuf: string[] = []
    while (i < parts.length) {
      const t = parts[i]
      if (t.startsWith("-") && known.has(t.toLowerCase())) break
      valBuf.push(t)
      i++
    }
    if (valBuf.length === 0) return { ok: false, error: `❌ ${flag} 缺少取值` }
    const val = valBuf.join(" ").trim()
    if (flag === "-name") updates.name = val
    else if (flag === "-cron") updates.cron = val
    else updates.content = val
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "❌ 至少指定一项：-name / -cron / -content" }
  }
  return { ok: true, oneBasedIndex: idx, updates }
}

const TASK_PREVIEW_BULLETS = ["①", "②", "③", "④", "⑤"] as const
function taskPreviewBullet(i: number): string { return TASK_PREVIEW_BULLETS[i] ?? `${i + 1}.` }
function formatTaskStatusLine(enabled: boolean): string { return enabled ? "✅ 运行中" : "⏸️ 已停止" }

export type TaskRunFn = (task: ScheduledTask, content: string) => Promise<{ ok: boolean; error?: string }>
export type TaskEnqueueFn = (content: string, chatId?: string) => Promise<{ ok: boolean; error?: string }>

export async function handleFeishuTaskCommand(
  port: number, messageId: string, raw: string, taskRunFn: TaskRunFn, chatId?: string, taskEnqueueFn?: TaskEnqueueFn,
  patchMessageId?: string,
): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const low = (s: string) => s.toLowerCase()
  const tExtra = (subtitle?: string) => cmdCardExtra(patchMessageId, "定时任务", subtitle)

  const taskHelpBtns = withNav([
    { label: "📋 任务列表", cmd: "/t ls" },
  ], patchMessageId)
  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP, chatId, taskHelpBtns, tExtra("菜单")); return }
  const sub = low(parts[1])
  if (sub === "help" || sub === "-h" || sub === "--help") { await reportCommandResult(port, messageId, true, TASK_SUBCMD_HELP, chatId, taskHelpBtns, tExtra("菜单")); return }

  let tasks = readTasksFromFile()

  if (sub === "ls") {
    if (tasks.length === 0) {
      await reportCommandResult(port, messageId, true, "📭 当前还没有定时任务～\n\n💡 需要的话可以用：\n   /t create <名称> <cron> <内容>", chatId, withNav([], patchMessageId), tExtra("列表"))
      return
    }
    const blocks = tasks.map((t, i) => {
      const n = i + 1
      return [
        "┈┈┈┈┈┈┈┈┈┈",
        `#${n}\t📋 名称 · ${t.name}`,
        `\t💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
        `\t🔄 Cron · ${t.cron}`,
        `\t⏱️ 下次 · ${t.enabled ? getNextCronFireLabel(t.cron) : "-"}`
      ].join("\n")
    })
    const header = `⏰ 定时任务一览（共 ${tasks.length} 条）`
    const detailBtns = tasks.slice(0, 6).map((t, i) => ({
      label: `#${i + 1} ${t.name}`.slice(0, 40),
      cmd: `/t info ${i + 1}`,
    }))
    await reportCommandResult(port, messageId, true, `${header}\n\n${blocks.join("\n\n")}\n\n✨ 点下方按钮或 /t info <序号> 看详情`, chatId, withNav(detailBtns, patchMessageId), tExtra("列表"))
    return
  }

  if (sub === "info") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t info <序号>（数字见 /t ls 的 #）", chatId, undefined, tExtra()); return }
    if (tasks.length === 0) { await reportCommandResult(port, messageId, false, "📭 还没有任何任务，先用 /t ls 确认一下吧～", chatId, undefined, tExtra()); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（当前共 ${tasks.length} 条）`, chatId, undefined, tExtra()); return }
    const t = tasks[idx - 1]
    let scheduleSection = ""
    const prev = previewCronNextRuns(t.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    }
    const body = [
      `📋 任务详情  #${idx}`, "",
      `📝 名称 · ${t.name}`,
      `💠 状态 · ${formatTaskStatusLine(t.enabled)}`,
      `🔄 Cron · ${t.cron}`,
      scheduleSection, "",
      "✉️ 任务内容", "────────────", t.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body, chatId, withNav([
      { label: "📋 任务列表", cmd: "/t ls" },
    ], patchMessageId), tExtra("详情"))
    return
  }

  if (sub === "run") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t run <序号>（数字见 /t ls 的 #）", chatId, undefined, tExtra()); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId, undefined, tExtra()); return }
    const t = tasks[idx - 1]
    const nowStr = new Date().toLocaleString("zh-CN")
    const content = `[定时任务: ${t.name}] (手动触发: ${nowStr})\n\n${t.content}`
    if (t.independent !== false) {
      const result = await taskRunFn(t, content)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已独立启动任务 #${idx} ${t.name}`, chatId, undefined, tExtra())
      } else {
        await reportCommandResult(port, messageId, false, `❌ 独立启动失败: ${result.error}`, chatId, undefined, tExtra())
      }
    } else {
      const enqueue = taskEnqueueFn ?? ((c, preferredChatId) => enqueueToMainSession(port, c, preferredChatId ?? chatId))
      const result = await enqueue(content, chatId)
      if (result.ok) {
        await reportCommandResult(port, messageId, true, `🚀 已手动触发任务 #${idx} ${t.name}`, chatId, undefined, tExtra())
      } else {
        await reportCommandResult(port, messageId, false, `❌ 触发失败: ${result.error}`, chatId, undefined, tExtra())
      }
    }
    return
  }

  if (sub === "stop") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t stop <序号>（数字见 /t ls 的 #）", chatId, undefined, tExtra()); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId, undefined, tExtra()); return }
    const name = tasks[idx - 1].name
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: false } : t))
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `⏸️ 已停止任务 #${idx} ${name}`, chatId, undefined, tExtra())
    return
  }

  if (sub === "start") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t start <序号>（数字见 /t ls 的 #）", chatId, undefined, tExtra()); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId, undefined, tExtra()); return }
    const name = tasks[idx - 1].name
    const cron = tasks[idx - 1].cron
    tasks = tasks.map((t, j) => (j === idx - 1 ? { ...t, enabled: true } : t))
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(cron)
    await reportCommandResult(port, messageId, true, `✅ 已启动任务 #${idx} ${name}\n下次执行: ${next}`, chatId, undefined, tExtra())
    return
  }

  if (sub === "delete") {
    const idx = parseTaskOneBasedIndex(parts[2])
    if (idx === null) { await reportCommandResult(port, messageId, false, "💡 用法：/t delete <序号>（数字见 /t ls 的 #）", chatId, undefined, tExtra()); return }
    if (idx > tasks.length) { await reportCommandResult(port, messageId, false, `😅 序号 ${idx} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId, undefined, tExtra()); return }
    const name = tasks[idx - 1].name
    tasks = tasks.filter((_, j) => j !== idx - 1)
    writeTasksToFile(tasks)
    await reportCommandResult(port, messageId, true, `🗑️ 已删除任务 #${idx} ${name}`, chatId, undefined, tExtra())
    return
  }

  if (sub === "create") {
    const parsed = parseTaskCreateArgs(parts)
    if (!parsed.ok) { await reportCommandResult(port, messageId, false, parsed.error, chatId, undefined, tExtra()); return }
    const taskChannel = chatId ? resolveChannelForSession(chatId) : undefined
    if (!taskChannel) {
      await reportCommandResult(port, messageId, false, "❌ 未找到当前会话所属的消息通道，无法创建任务", chatId, undefined, tExtra())
      return
    }
    const newTask: ScheduledTask = { id: randomUUID(), name: parsed.name, cron: parsed.cron, content: parsed.content, enabled: true, channelId: taskChannel.id }
    tasks = [...tasks, newTask]
    writeTasksToFile(tasks)
    const next = getNextCronFireLabel(parsed.cron)
    await reportCommandResult(port, messageId, true, `✅ 已创建并启动：${parsed.name}\n下次执行: ${next}`, chatId, undefined, tExtra())
    return
  }

  if (sub === "update") {
    const pu = parseTaskUpdateArgs(parts)
    if (!pu.ok) { await reportCommandResult(port, messageId, false, pu.error, chatId, undefined, tExtra()); return }
    if (pu.oneBasedIndex > tasks.length) {
      await reportCommandResult(port, messageId, false, `😅 序号 ${pu.oneBasedIndex} 对应的任务不存在哦（共 ${tasks.length} 条）`, chatId, undefined, tExtra())
      return
    }
    const t = tasks[pu.oneBasedIndex - 1]
    let nextName = t.name, nextCron = t.cron, nextContent = t.content
    if (pu.updates.name !== undefined) nextName = pu.updates.name
    if (pu.updates.cron !== undefined) nextCron = pu.updates.cron
    if (pu.updates.content !== undefined) nextContent = pu.updates.content
    if (pu.updates.cron !== undefined && !validateCron(nextCron)) {
      await reportCommandResult(port, messageId, false, "😅 新 Cron 表达式无效", chatId, undefined, tExtra())
      return
    }
    const updated: ScheduledTask = { ...t, name: nextName, cron: nextCron, content: nextContent }
    tasks = tasks.map((x, j) => (j === pu.oneBasedIndex - 1 ? updated : x))
    writeTasksToFile(tasks)
    let scheduleSection = ""
    const prev = previewCronNextRuns(updated.cron)
    if (prev.ok) {
      const lines = prev.runs.map((r, i) => `   ${taskPreviewBullet(i)} ${r}`)
      scheduleSection = `⏱️ 最近计划触发（${prev.runs.length} 次预览）\n${lines.join("\n")}`
    }
    const body = [
      `✅ 已更新任务`, `📋 任务详情  #${pu.oneBasedIndex}`, "",
      `📝 名称 · ${updated.name}`,
      `💠 状态 · ${formatTaskStatusLine(updated.enabled)}`,
      `🔄 Cron · ${updated.cron}`,
      scheduleSection, "",
      "✉️ 任务内容", "────────────", updated.content,
    ].join("\n")
    await reportCommandResult(port, messageId, true, body, chatId, withNav([
      { label: "📋 任务列表", cmd: "/t ls" },
    ], patchMessageId), tExtra("详情"))
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知指令: ${parts[1]}\n\n${TASK_SUBCMD_HELP}`, chatId, taskHelpBtns, tExtra())
}

// ── MCP 命令 ──────────────────────────────────────────────

const MCP_SUBCMD_HELP = [
  "💡 /mc MCP 工具",
  "🔹 /mc ls — 列出 MCP 服务器",
  "🔹 /mc info <序号|名称> — 查看详情",
  "🔹 /mc enable <序号|名称> — 启用",
  "🔹 /mc disable <序号|名称> — 禁用",
  "🔹 /mc delete <序号|名称> — 删除",
  "🔹 /mc add <配置> — 添加 MCP（JSON 配置）",
].join("\n")

function resolveMcpTarget(list: McpServerEntry[], token: string): McpServerEntry | null {
  const idx = parseInt(token, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]
  return list.find((s) => s.name.toLowerCase() === token.toLowerCase()) ?? null
}

export async function handleFeishuMcpCommand(port: number, messageId: string, raw: string, chatId?: string, patchMessageId?: string): Promise<void> {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0)
  const mcExtra = (subtitle?: string) => cmdCardExtra(patchMessageId, "MCP", subtitle)

  const mcpHelpBtns = withNav([
    { label: "📋 服务器列表", cmd: "/mc ls" },
  ], patchMessageId)
  if (parts.length <= 1) { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP, chatId, mcpHelpBtns, mcExtra("菜单")); return }
  const sub = parts[1].toLowerCase()
  if (sub === "help" || sub === "-h") { await reportCommandResult(port, messageId, true, MCP_SUBCMD_HELP, chatId, mcpHelpBtns, mcExtra("菜单")); return }

  if (sub === "ls" || sub === "list") {
    const list = getMcpServerList()
    const enabledMap = await getMcpEnabledMap()
    if (list.length === 0) { await reportCommandResult(port, messageId, true, "📭 暂无 MCP 服务器", chatId, withNav([], patchMessageId), mcExtra("列表")); return }
    const lines = list.map((s, i) => {
      const flag = enabledMap[s.name] === false ? "🔴" : "🟢"
      const src = "[C]"
      const detail = s.type === "url" ? s.url : s.command
      return `  ${i + 1}. ${flag} ${src} ${s.name}  (${detail})`
    })
    const detailBtns = list.slice(0, 6).map((s, i) => ({
      label: `#${i + 1} ${s.name}`.slice(0, 40),
      cmd: `/mc info ${i + 1}`,
    }))
    await reportCommandResult(port, messageId, true, `📦 MCP 服务器：\n${lines.join("\n")}\n\n💡 点下方按钮或 /mc info <序号|名称> 看详情`, chatId, withNav(detailBtns, patchMessageId), mcExtra("列表"))
    return
  }

  if (sub === "info") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mc info <序号|名称>", chatId, undefined, mcExtra()); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId, undefined, mcExtra()); return }
    const enabledMap = await getMcpEnabledMap()
    const lines = [
      `📦 ${target.name}`,
      `  类型: ${target.type}`,
      `  来源: ${target.source}`,
      `  状态: ${enabledMap[target.name] === false ? "🔴 已禁用" : "🟢 已启用"}`,
    ]
    if (target.type === "url") lines.push(`  URL: ${target.url}`)
    else lines.push(`  命令: ${target.command} ${(target.args ?? []).join(" ")}`)
    if (target.env && Object.keys(target.env).length > 0) {
      lines.push(`  环境变量: ${Object.keys(target.env).join(", ")}`)
    }
    await reportCommandResult(port, messageId, true, lines.join("\n"), chatId, withNav([
      { label: "📋 服务器列表", cmd: "/mc ls" },
    ], patchMessageId), mcExtra("详情"))
    return
  }

  if (sub === "enable" || sub === "disable") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, `用法: /mc ${sub} <序号|名称>`, chatId, undefined, mcExtra()); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId, undefined, mcExtra()); return }
    const enabled = sub === "enable"
    const result = await toggleMcpServer(target.name, enabled)
    await reportCommandResult(port, messageId, result.ok,
      result.ok ? `✅ ${target.name} 已${enabled ? "启用" : "禁用"}` : `❌ 操作失败: ${result.output}`, chatId, undefined, mcExtra())
    return
  }

  if (sub === "delete" || sub === "rm") {
    const list = getMcpServerList()
    const token = parts[2]
    if (!token) { await reportCommandResult(port, messageId, false, "用法: /mc delete <序号|名称>", chatId, undefined, mcExtra()); return }
    const target = resolveMcpTarget(list, token)
    if (!target) { await reportCommandResult(port, messageId, false, `❌ 找不到: ${token}`, chatId, undefined, mcExtra()); return }
    deleteMcpServer(target.name)
    await reportCommandResult(port, messageId, true, `🗑️ ${target.name} 已删除`, chatId, undefined, mcExtra())
    return
  }

  if (sub === "add") {
    const jsonStr = raw.replace(/^\/mcp\s+add\s*/i, "").trim()
    if (!jsonStr) {
      await reportCommandResult(port, messageId, false, '用法: /mc add {"name":"xxx","command":"npx","args":[...]}', chatId, undefined, mcExtra())
      return
    }
    try {
      const parsed = JSON.parse(jsonStr)
      const name = parsed.name as string
      if (!name) { await reportCommandResult(port, messageId, false, "❌ 缺少 name 字段", chatId, undefined, mcExtra()); return }
      const { name: _, ...entry } = parsed
      saveMcpServer(name, entry, "project")
      await reportCommandResult(port, messageId, true, `✅ ${name} 已添加`, chatId, undefined, mcExtra())
    } catch (e: unknown) {
      await reportCommandResult(port, messageId, false, `❌ JSON 解析失败: ${e instanceof Error ? e.message : e}`, chatId, undefined, mcExtra())
    }
    return
  }

  await reportCommandResult(port, messageId, false, `😅 未知指令: ${sub}\n\n${MCP_SUBCMD_HELP}`, chatId, mcpHelpBtns, mcExtra())
}
