// ── 应用内对话：回复完成的系统通知 ─────────────────────────────────────
// 什么时候弹、弹什么写在这里（纯逻辑，主进程接线见 electron/app-chat-notify.ts）：
// 回合卡正常收口、而你没在看这个会话时，弹一条通知，正文是回复的开头。

import {
  appChatSessionId,
  type AppChatAssistantItem,
  type AppChatEvent,
  type AppChatItem,
  type AppChatSegment,
} from "./app-chat-types.js"

/** 正文最多显示多少个字：系统通知只给两三行，再长也会被截掉 */
export const NOTICE_BODY_MAX_CHARS = 100
/** 标题（会话名）最多显示多少个字 */
export const NOTICE_TITLE_MAX_CHARS = 60
/** 回复里没有文字（只调了工具、只提了问题）时的正文 */
export const NOTICE_FALLBACK_BODY = "回复已完成"
/** 取回复开头多少个字来整理：比正文上限大得多，记号被去掉之后仍然够填满正文 */
const RAW_PREVIEW_CHARS = 4000
/** 记住最近多少个已处理的回合卡：同一张卡的重复事件不能再弹一次 */
const SEEN_CARD_MEMORY = 200

export interface ReplyNotice {
  sessionKey: string
  title: string
  body: string
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join("").trimEnd()}…`
}

/**
 * Markdown 回复整理成通知里能读的一行：去掉标题/列表/引用/强调/链接/表格这些记号，保留文字，折成一行。
 * 只是给人扫一眼，不求把 Markdown 完整解析。
 */
export function markdownToPlainLine(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    // 代码围栏只去掉标记行，里面的内容留着
    .replace(/^[ \t]*(```|~~~).*$/gm, "")
    // 分隔线、表格的表头分隔行（只有 - | : 和空白，且至少一个 -）
    .replace(/^[ \t]*[|:\- \t]*-[|:\- \t]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 只处理换行标签：别的尖括号多半是 a<b、List<String> 这类正文，不能当 HTML 标签吃掉
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\|/g, " ")
    // 成对的强调/删除线/行内代码；单个 * _ 只在词边界处才算强调，snake_case 之类不动
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(\S(?:[^\n]*?\S)?)\2(?![\w*])/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim()
}

/** 回复预览：最后一段有文字的回复（通常就是结论），整理成一行后截断；没有文字返回空串 */
export function replyPreview(segments: readonly AppChatSegment[], maxChars = NOTICE_BODY_MAX_CHARS): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.type !== "reply") continue
    // 只显示开头一小段，长回复没必要整篇过一遍正则
    const line = markdownToPlainLine(seg.text.slice(0, RAW_PREVIEW_CHARS))
    if (line) return clip(line, maxChars)
  }
  return ""
}

/** 正常收口的回合卡：用户停止、切模型、重置这类被打断的不算「回复完成」 */
export function isFinishedReply(item: AppChatItem): item is AppChatAssistantItem {
  return item.kind === "assistant" && item.finished && !item.interrupted
}

/** 你是不是正看着这个会话：窗口在前台，且对话页停在这个会话上 */
export function isViewingSession(viewing: string | null, sessionKey: string, windowActive: boolean): boolean {
  return windowActive && !!viewing && appChatSessionId(viewing) === appChatSessionId(sessionKey)
}

export interface ReplyNotifierDeps {
  /** 你是不是正看着这个会话；看着就不用弹 */
  isViewing(sessionKey: string): boolean
  /** 会话在界面上叫什么 */
  sessionName(sessionKey: string): string
  show(notice: ReplyNotice): void
}

/**
 * 订阅应用内聊天事件的监听器：回合卡正常收口时，你没在看这个会话就弹通知。
 * 每张回合卡只处理一次（先记下再判断是否在看）：之后同一张卡的重复事件，不会在你离开后再弹一次。
 */
export function createReplyNotifier(deps: ReplyNotifierDeps): (event: AppChatEvent) => void {
  const seen = new Set<string>()
  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > SEEN_CARD_MEMORY) seen.delete(seen.values().next().value as string)
  }

  return (event) => {
    if (event.type !== "item" || !isFinishedReply(event.item) || seen.has(event.item.id)) return
    remember(event.item.id)
    if (deps.isViewing(event.sessionKey)) return
    deps.show({
      sessionKey: event.sessionKey,
      title: clip(deps.sessionName(event.sessionKey).trim() || "应用内会话", NOTICE_TITLE_MAX_CHARS),
      body: replyPreview(event.item.segments) || NOTICE_FALLBACK_BODY,
    })
  }
}
