/**
 * 飞书消息正文里的 @ 占位符（@_user_N）还原成文字。
 *
 * 同一条消息要算出两份文本，因为有两类读者：
 * - 指令识别、建项草稿、日志：要「干净」的正文。群里常见「@机器人 /p use xxx」，不剥掉 @ 就认不出是指令。
 * - Agent：要知道「这条消息 @ 了谁、其中有没有我」。之前 @ 自己被整个删掉，一条「@A @我 @B 大家好」
 *   到 Agent 手里变成「@A @B 大家好」，它会据此判断「这条没提到我」，结果该回的不回、回了也不知道在对谁说。
 *
 * 纯逻辑，不依赖 daemon 的全局状态，方便单测。
 */

import type { LarkMention } from "./lark-core.js"

/** 保留 @ 自己时附在名字后面的标注，让 Agent 一眼看出这个 @ 指的就是它 */
export const SELF_MENTION_NOTE = "你自己"

export interface ResolveMentionOptions {
  /** 保留 @ 自己（标注成「@名字(你自己)」）；缺省删除，和指令识别的口径一致 */
  keepSelf?: boolean
}

/**
 * 将 `@_user_N` 占位符还原为可读形式：
 * - @自己 → 默认删除；keepSelf 时写成 `@名字(你自己)`
 * - @所有人 → 删除
 * - @其他人/机器人 → `@名字(open_id=ou_xxx)`，Agent 可直接取 open_id 回 @
 */
export function resolveMentionTags(
  text: string,
  mentions: readonly LarkMention[],
  selfOpenId?: string,
  opts: ResolveMentionOptions = {},
): string {
  let out = text
  for (const m of mentions) {
    if (!m.key) continue
    const isSelf = !!selfOpenId && m.id === selfOpenId
    let replacement: string
    if (m.key === "@_all") replacement = ""
    else if (isSelf) replacement = opts.keepSelf ? (m.name ? `@${m.name}(${SELF_MENTION_NOTE})` : `@${SELF_MENTION_NOTE}`) : ""
    else replacement = m.id ? `@${m.name}(open_id=${m.id})` : `@${m.name}`
    out = out.split(m.key).join(replacement)
  }
  out = out.replace(/@_user_\d+/g, "")
  if (!mentions.length) return out.trim()
  return out.replace(/[ \t]{2,}/g, " ").trim()
}

export interface InboundTexts {
  /** 剥掉 @ 自己的正文：指令识别、建项草稿、日志、判空都用它 */
  command: string
  /** 投递给 Agent 的正文：群聊里保留 @ 自己；其余情况和 command 一样 */
  agent: string
}

/**
 * 一条入站消息的两份文本。
 * - 私聊：@ 自己没有信息量（对面只有一个人），两份一样，行为不变。
 * - 群聊：agent 保留 @ 自己。
 * - 剥掉 @ 之后正文为空（只 @ 了机器人）：agent 也给空串，不拿「@名字(你自己)」顶上去——
 *   daemon 的 pushMessage 对「正文为空」有专门处理（带引用时提示 Agent 去看引用的原文），
 *   正文一旦非空，这个兜底就被悄悄绕过了。
 */
export function resolveInboundTexts(
  text: string,
  mentions: readonly LarkMention[],
  selfOpenId: string | undefined,
  chatType: string | undefined,
): InboundTexts {
  const command = resolveMentionTags(text, mentions, selfOpenId)
  if (chatType === "p2p" || !command) return { command, agent: command }
  return { command, agent: resolveMentionTags(text, mentions, selfOpenId, { keepSelf: true }) }
}
