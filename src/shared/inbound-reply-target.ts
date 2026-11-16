/**
 * 飞书里「这一轮在回应哪条用户消息」。
 *
 * 发文件、发图片、问题卡、指令卡都按同一条规则决定要不要以「回复」的方式发出（daemon 的 shouldReplyToMessage），
 * 但 Agent 的主回复是流式卡片，建卡时只有会话 key、没有 message_id，一直是直发——
 * 同一个群里，文件带着引用，正文却没有。这里记下每个会话最近投递给 Agent 的那条用户消息，建卡时拿来当回复对象。
 *
 * 纯逻辑，不依赖 daemon 的全局状态，方便单测。
 */

/** 一批投递给 Agent 的消息里，和「回复谁」有关的那一点 */
export interface DeliveredMessageRef {
  messageId?: string
}

/**
 * 卡片按钮点击产生的内部消息（id 形如 internal_card_<时间戳>）。
 * 用户点按钮还是在同一段对话里，它不是新的触发源：沿用原来的回复对象，不然点完按钮后的回复又没有引用了。
 */
const CARD_CLICK_PREFIX = "internal_card_"

/** 是不是用户在飞书里发的消息：internal_ 开头的是系统自己造的（定时任务、排程、卡片点击等），不是飞书 message_id，不能拿来 reply */
export function isUserMessageId(id: string | undefined): id is string {
  return !!id && !id.startsWith("internal_")
}

export type ReplyTargetUpdate =
  | { kind: "set"; messageId: string }
  | { kind: "keep" }
  | { kind: "clear" }

/**
 * 这一批投递对回复对象的影响：
 * - 有用户消息：以最后一条为准（用户连发几条，引用最新的那条）
 * - 全是卡片点击：保持原来的
 * - 其余只有系统消息（定时任务、排程投递）：清掉。没有人在等这条回复，去引用几小时甚至几天前的一条旧消息反而怪
 * - 没有任何 messageId：不是投递，不动
 */
export function replyTargetUpdateFor(messages: readonly DeliveredMessageRef[]): ReplyTargetUpdate {
  const ids = messages.map((m) => m.messageId).filter((id): id is string => !!id)
  if (ids.length === 0) return { kind: "keep" }
  for (let i = ids.length - 1; i >= 0; i--) {
    if (isUserMessageId(ids[i])) return { kind: "set", messageId: ids[i] }
  }
  if (ids.every((id) => id.startsWith(CARD_CLICK_PREFIX))) return { kind: "keep" }
  return { kind: "clear" }
}

export interface ReplyTargetTracker {
  /** Agent 领到这批消息时调用 */
  observeDelivery(sessionKey: string, messages: readonly DeliveredMessageRef[]): void
  /** 这个会话当前的回复对象；没有就是 undefined */
  get(sessionKey: string): string | undefined
  /** 会话删除时调用 */
  forget(sessionKey: string): void
  readonly size: number
}

/** max：最多记多少个会话，超出时丢最久没更新的 */
export function createReplyTargetTracker(max = 1000): ReplyTargetTracker {
  const targets = new Map<string, string>()
  return {
    observeDelivery(sessionKey, messages) {
      if (!sessionKey) return
      const update = replyTargetUpdateFor(messages)
      if (update.kind === "keep") return
      // 先删再放：Map 按插入顺序，这样最近更新的排最后，淘汰时丢最前面的
      targets.delete(sessionKey)
      if (update.kind === "clear") return
      targets.set(sessionKey, update.messageId)
      while (targets.size > max) {
        const oldest = targets.keys().next().value
        if (oldest === undefined) break
        targets.delete(oldest)
      }
    },
    get(sessionKey) {
      return targets.get(sessionKey)
    },
    forget(sessionKey) {
      targets.delete(sessionKey)
    },
    get size() {
      return targets.size
    },
  }
}

/**
 * 以回复的方式发送，失败退回直发。
 * 回复会因为目标消息被撤回/删除等原因失败，这时候卡片不能丢，要改成直接发到会话里。
 * send 的返回值沿用 LarkSender：字符串=已发出且拿到 message_id，null=已发出但没拿到 id，undefined=失败。
 */
export async function sendReplyWithBackoff(
  send: (replyTo: string | undefined) => Promise<string | null | undefined>,
  replyTo: string | undefined,
  onBackoff?: (replyTo: string) => void,
): Promise<string | null | undefined> {
  if (!replyTo) return send(undefined)
  const sent = await send(replyTo)
  if (sent !== undefined) return sent
  onBackoff?.(replyTo)
  return send(undefined)
}
