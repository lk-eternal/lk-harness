/**
 * 修复被「Resume 补发收口」改坏的回复耗时。
 *
 * 背景：下一条消息让 Agent 重新拉起（Resume）时，会按记着的卡 id 再补发一次 finish，旧版本的 app-channel
 * 对已收口的卡也重新盖了一次 finishedAt，于是这张旧回复的「耗时」变成「从这条回复到下一条消息」的整段时间
 * （几小时也有）。现在的代码已经不再改已收口的卡（见 tests/app-chat-finish-idempotent.test.ts），
 * 但磁盘上已经被改过的记录不会自己好。
 *
 * 真实耗时已经丢了，没法算回来，能做的只是去掉那个错误的「耗时」页脚（清掉 finishedAt，卡本身不动）。
 *
 * 判定（启发式，所以脚本默认只预览）：一张已收口的回复卡，它后面第一条用户消息的时间是 t，
 * 而它的 finishedAt 落在 [t, t + 窗口] 里——真实的收口一定在下一条消息之前，除非那条消息是它运行中排进来的；
 * 被 Resume 改写的收口则几乎总是紧跟在下一条消息之后 2～5 秒。窗口之外的（比如运行中排队的消息很久之后才收口）一律不动。
 */

/** 收口时间落在下一条用户消息之后多少毫秒内，算被 Resume 改写 */
export const REFINISH_WINDOW_MS = 10_000

interface LooseItem {
  kind?: unknown
  ts?: unknown
  finishedAt?: unknown
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** 返回被改坏的回复卡在 items 里的下标。items 里不是对象的（解析失败的行）当作不存在 */
export function findRefinishedCards(
  items: readonly (LooseItem | null | undefined)[],
  windowMs = REFINISH_WINDOW_MS,
): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const card = items[i]
    if (!card || card.kind !== "assistant" || !isNum(card.finishedAt) || !isNum(card.ts)) continue
    let next: LooseItem | undefined
    for (let j = i + 1; j < items.length; j++) {
      const it = items[j]
      if (it && it.kind === "user" && isNum(it.ts)) {
        next = it
        break
      }
    }
    if (!next || !isNum(next.ts)) continue
    // 下一条用户消息不能比这张卡还早（排序异常的数据不碰）
    if (next.ts < card.ts) continue
    if (card.finishedAt >= next.ts && card.finishedAt - next.ts <= windowMs) out.push(i)
  }
  return out
}

export interface RepairResult {
  text: string
  /** 回复卡总数（assistant） */
  cards: number
  /** 去掉了耗时的卡数 */
  repaired: number
}

/**
 * 修一份 jsonl 文本。没有要修的行原样不动（连换行符和空行都保留），只有被判定的行才重新序列化。
 * 解析不了的行也原样保留，绝不丢内容。
 */
export function repairJsonlText(text: string, windowMs = REFINISH_WINDOW_MS): RepairResult {
  const lines = text.split("\n")
  const items = lines.map((line): LooseItem | null => {
    const s = line.trim()
    if (!s) return null
    try {
      const v: unknown = JSON.parse(s)
      return v && typeof v === "object" ? (v as LooseItem) : null
    } catch {
      return null
    }
  })
  const cards = items.filter((it) => it?.kind === "assistant").length
  const targets = findRefinishedCards(items, windowMs)
  for (const i of targets) {
    const copy = { ...(items[i] as Record<string, unknown>) }
    delete copy.finishedAt
    const cr = lines[i]!.endsWith("\r") ? "\r" : ""
    lines[i] = JSON.stringify(copy) + cr
  }
  return { text: lines.join("\n"), cards, repaired: targets.length }
}
