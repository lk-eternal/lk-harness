// ── 点选提问（send_question）的多选 ─────────────────────────────────────
// 多选题：用户勾选若干项，点「提交」才作答。交给 Agent 的答案是被选中的选项文本，按题目里的顺序用「、」连起来。
// 飞书卡片、应用内对话（桌面端和手机端）共用这里的规则：怎么勾、怎么拼成答案、怎么从答案还原勾选。

/** 多选答案里各项之间的分隔符 */
export const MULTI_ANSWER_SEP = "、"

/**
 * 勾选 / 取消勾选一项。结果总是按题目里选项的顺序排好（和点击顺序无关），
 * 所以同一组勾选永远得到同一个答案；不在选项里的内容忽略。
 */
export function toggleChoice(options: readonly string[], selected: readonly string[] | undefined, opt: string): string[] {
  const current = new Set(selected ?? [])
  if (!options.includes(opt)) return options.filter((o) => current.has(o))
  if (current.has(opt)) current.delete(opt)
  else current.add(opt)
  return options.filter((o) => current.has(o))
}

/** 把勾选的项拼成交给 Agent 的答案（按题目顺序，用「、」连起来）；一项都没勾返回空串 */
export function joinChoices(options: readonly string[], selected: readonly string[] | undefined): string {
  const chosen = new Set(selected ?? [])
  return options.filter((o) => chosen.has(o)).join(MULTI_ANSWER_SEP)
}

/**
 * 飞书表单里第 index 个选项的勾选框 name。飞书要求 name 在整张卡内唯一，
 * 而一张流式卡里可能同时有好几道题，所以每道题用自己的 prefix 区分。
 */
export function checkerFieldName(prefix: string, index: number): string {
  return `${prefix}_${index}`
}

/** 勾选框在表单提交里的值：官方实际回传布尔，也兼容字符串 "true"（飞书开放平台官方示例同样这样判断） */
function isChecked(raw: unknown): boolean {
  return raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true")
}

/**
 * 从飞书表单提交值（form_value）读出这道题勾选了哪些选项，按题目顺序返回。
 * 表单里一个本题的勾选框字段都没有时返回 null——说明这次提交不带勾选内容（旧版卡片、
 * 客户端太旧没回传），调用方要和「一项没勾」区分开：前者提示改用文字回复，后者提示先勾选。
 */
export function readFormChoices(
  options: readonly string[],
  formValue: Readonly<Record<string, unknown>> | undefined,
  prefix: string,
): string[] | null {
  if (!formValue) return null
  const names = options.map((_, i) => checkerFieldName(prefix, i))
  if (!names.some((n) => n in formValue)) return null
  return options.filter((_, i) => isChecked(formValue[names[i]]))
}

/**
 * 在选项（按题目顺序）里找一种切法，正好把答案切完：答案剩余部分以某个选项开头、后面紧跟分隔符或结束。
 * 会回溯：选项 A 和 A、B 同时存在时，答案「A、B」先试 A 发现剩下的 B 切不了，再退回去整个当 A、B。
 * 切不通的状态只算一次（dead）：剩余部分总是答案的一个后缀，所以「剩余长度 + 从第几个选项往后找」就唯一确定一个状态。
 * 没有这一步，选项里有重复、或一串前缀相同的选项，再配上一个切不干净的答案，回溯的次数是指数级的。
 */
function segmentAnswer(rest: string, options: readonly string[], from: number, dead: Set<number> = new Set()): string[] | null {
  const state = rest.length * (options.length + 1) + from
  if (dead.has(state)) return null
  for (let k = from; k < options.length; k++) {
    const o = options[k]
    if (!o) continue
    if (rest === o) return [o]
    if (rest.startsWith(o + MULTI_ANSWER_SEP)) {
      const tail = segmentAnswer(rest.slice(o.length + MULTI_ANSWER_SEP.length), options, k + 1, dead)
      if (tail) return [o, ...tail]
    }
  }
  dead.add(state)
  return null
}

/**
 * 从答案还原勾选（joinChoices 的反过程）。按题目顺序逐项对：答案剩余部分以这个选项开头、
 * 后面紧跟分隔符或结束，才算选了它——这样选项文本里自己带「、」也不会被拆错。
 * 答案整个切不干净（比如选项后来改过）时退回宽松模式：能认出来的认，认不出来的部分忽略。
 */
export function splitChoices(answer: string | undefined, options: readonly string[]): string[] {
  if (!answer) return []
  const exact = segmentAnswer(answer, options, 0)
  if (exact) return exact
  const out: string[] = []
  let rest = answer
  for (const o of options) {
    if (!o) continue
    if (rest === o) { out.push(o); rest = ""; break }
    if (rest.startsWith(o + MULTI_ANSWER_SEP)) {
      out.push(o)
      rest = rest.slice(o.length + MULTI_ANSWER_SEP.length)
    }
  }
  return out
}
