/**
 * 每轮交给 AI 的用户消息：一轮对话包成标签（turn / memory / task / history / message / quote / node-routing）。
 * 标签里是原文，不转义，只中和信封标签的结束标签（promptText）。
 * 拼装和解析（carryover 从账本里还原用户原文）都在这一处，格式只在这里定。
 */

import { promptAttr, promptNow, promptText, promptTime } from "./prompt-markup.js"
import { formatMemoryItems, type SessionMemoryEntry } from "./session-memory.js"

export const MESSAGE_FORMAT_BLOCK = [
  "# 消息格式",
  "",
  "每轮的用户消息由应用包成下面的标签交给你。标签里是原文，没有转义；原文里出现这些标签的结束标签时，写成 `<\\/message>` 这样，按字面文字看。",
  "",
  "- `<turn chat channel now>`：一轮对话。chat 是会话类型，channel 是消息来自的通道，now 是现在的本机日期、星期、时间和时区。",
  "- `<message id at from sender>`：一条消息。id 是消息 ID，回复这条消息时传给工具的 message_id（应用内部下发的消息没有 id）；at 是发送时间；from 是发送者类型；sender 是发送者标识。",
  "- `<quote id from sender>`：这条消息引用的另一条消息，放在消息正文之前。",
  "- `<memory>`：你之前记下的会话记忆，每条 `<item>` 带创建时间和修改时间。",
  "- `<history>`：上一个会话搬来的最近几轮，只作背景。",
  "- `<task>`：这个会话的任务说明。",
  "- `<node-routing>`：项目会话每轮附带的节点路由，说明什么时候先取节点的完整提示词。",
].join("\n")

export interface EnvelopeQuote {
  id: string
  from: string
  sender?: string
  text: string
}

export interface EnvelopeMessage {
  id?: string
  /** 发送时间（毫秒） */
  at?: number
  from?: string
  sender?: string
  text: string
  quote?: EnvelopeQuote
}

export interface EnvelopeNodeRouting {
  projectId: string
  nodes: { id: string; label: string }[]
}

export interface TurnEnvelope {
  /** 会话类型 */
  chat?: string
  /** 消息来自的通道 */
  channel?: string
  /** 现在（毫秒） */
  now: number
  memory?: SessionMemoryEntry[]
  task?: string
  history?: EnvelopeMessage[]
  messages: EnvelopeMessage[]
  nodeRouting?: EnvelopeNodeRouting
}

function openTag(name: string, attrs: Record<string, string | undefined>): string {
  const parts = Object.entries(attrs)
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([k, v]) => `${k}="${promptAttr(v)}"`)
  return parts.length ? `<${name} ${parts.join(" ")}>` : `<${name}>`
}

function wrap(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`
}

function renderQuote(q: EnvelopeQuote): string {
  return `${openTag("quote", { id: q.id, from: q.from, sender: q.sender })}\n${promptText(q.text)}\n</quote>`
}

function renderMessage(m: EnvelopeMessage): string {
  const open = openTag("message", { id: m.id, at: m.at ? promptTime(m.at) : undefined, from: m.from, sender: m.sender })
  return [open, ...(m.quote ? [renderQuote(m.quote)] : []), promptText(m.text), "</message>"].join("\n")
}

function renderNodeRouting(r: EnvelopeNodeRouting): string {
  const nodes = r.nodes.map((n) => `${n.label} ${n.id}`).join(" · ")
  const rule = `判断用户消息是否明确对应某节点：命中就先调 project_get_node(project_id=${r.projectId}, node_id=命中的 id) 取完整提示词再做；没命中直接处理消息。`
  return `${openTag("node-routing", { project: r.projectId })}\n${promptText(`${nodes}\n${rule}`)}\n</node-routing>`
}

export function buildTurnEnvelope(turn: TurnEnvelope): string {
  const parts = [
    ...(turn.memory?.length ? [wrap("memory", formatMemoryItems(turn.memory))] : []),
    ...(turn.task ? [wrap("task", promptText(turn.task))] : []),
    ...(turn.history?.length ? [wrap("history", turn.history.map(renderMessage).join("\n"))] : []),
    ...turn.messages.map(renderMessage),
    ...(turn.nodeRouting ? [renderNodeRouting(turn.nodeRouting)] : []),
  ]
  const open = openTag("turn", { chat: turn.chat, channel: turn.channel, now: promptNow(turn.now) })
  return [open, ...parts, "</turn>"].join("\n")
}

const TURN = /^<turn\b[^>]*>\n([\s\S]*)\n<\/turn>\s*$/m
const TOP_LEVEL_ELEMENT = /<(memory|task|history|message|node-routing)\b[^>]*>\n([\s\S]*?)\n<\/\1>/g
const LEADING_QUOTE = /^<quote\b[^>]*>\n[\s\S]*?\n<\/quote>\n/

/**
 * 从一条用户提示词里还原本轮消息的原文（不含记忆、任务、历史、引用、节点路由）。
 * 不是 turn 信封返回 undefined。顺序扫描、整块消费：某个元素里面出现的标签文字，不会被当成顶层元素。
 */
export function turnMessageTexts(prompt: string): string[] | undefined {
  const turn = TURN.exec(prompt.trim())
  if (!turn) return undefined
  const texts: string[] = []
  for (const el of turn[1]!.matchAll(TOP_LEVEL_ELEMENT)) {
    if (el[1] !== "message") continue
    const text = el[2]!.replace(LEADING_QUOTE, "").trim()
    if (text) texts.push(text)
  }
  return texts
}
