import type { ProjectFieldDef, ProjectNodeGroupDef } from "./project-types.js"

/**
 * 通用项目模板：不依赖 git / 飞书 / GitLab，什么岗位都能用。
 * 节点 id 全局唯一（不能和开发/测试组的 id 撞，也不能撞 /p 保留子命令）；
 * 节点提示词住在 project-node-guides.ts 的 ACTION_GUIDES 里，这里只放骨架。
 */
export const GENERAL_NODE_GROUPS: ProjectNodeGroupDef[] = [
  {
    id: "general",
    name: "通用任务",
    description: "什么事都能用：先说清目标，再拆解、推进、复盘。",
    workspace: "plain",
    nodes: [
      { id: "clarify", label: "明确目标" },
      { id: "breakdown", label: "拆解计划" },
      { id: "execute", label: "推进执行" },
      { id: "recap", label: "总结复盘" },
    ],
  },
  {
    id: "research",
    name: "调研分析",
    description: "做行业、竞品、方案调研：定问题、找资料、做分析、出报告。",
    workspace: "plain",
    fields: [
      { label: "交付形式", placeholder: "如：5 页 PPT / 2000 字报告" },
      { label: "使用对象", placeholder: "这份调研给谁看、拿来做什么决定" },
      { label: "截止时间", placeholder: "如：本周五" },
    ],
    nodes: [
      { id: "scope", label: "界定问题" },
      { id: "gather", label: "收集资料" },
      { id: "analyze", label: "分析对比" },
      { id: "write-report", label: "撰写报告" },
    ],
  },
  {
    id: "writing",
    name: "文档写作",
    description: "写方案、文章、邮件、通稿：拟大纲、写初稿、按反馈改、润色定稿。",
    workspace: "plain",
    fields: [
      { label: "文体类型", placeholder: "如：产品方案 / 新闻稿 / 汇报邮件" },
      { label: "读者", placeholder: "谁来读，对这个话题了解多少" },
      { label: "篇幅", placeholder: "如：1500 字左右 / 3 页" },
      { label: "语气风格", placeholder: "如：正式简洁 / 轻松口语" },
    ],
    nodes: [
      { id: "outline", label: "拟大纲" },
      { id: "draft", label: "写初稿" },
      { id: "revise", label: "按反馈修改" },
      { id: "polish", label: "润色定稿" },
    ],
  },
  {
    id: "report",
    name: "周报月报",
    description: "定期汇报：汇总这段时间做了什么，写成报告，并列出下期计划。",
    workspace: "plain",
    fields: [
      { label: "汇报对象", placeholder: "如：部门负责人 / 客户" },
      { label: "汇报周期", placeholder: "如：每周五 / 每月最后一个工作日" },
      { label: "资料来源", placeholder: "本期工作记录在哪：文件夹、文档、聊天记录、日历…", multiline: true },
      { label: "格式要求", placeholder: "有固定模板或栏目就写在这里", multiline: true },
    ],
    nodes: [
      { id: "collect-progress", label: "汇总进展" },
      { id: "draft-report", label: "撰写报告" },
      { id: "next-plan", label: "下期计划" },
    ],
  },
  {
    id: "event",
    name: "活动策划",
    description: "组织会议、活动、发布：定目标和约束、出方案、列清单、事后复盘。",
    workspace: "plain",
    fields: [
      { label: "活动时间", placeholder: "如：12 月 20 日下午" },
      { label: "预算", placeholder: "如：2 万以内" },
      { label: "参与对象", placeholder: "谁来、大概多少人" },
      { label: "场地与形式", placeholder: "线上 / 线下 / 混合，场地有没有定" },
    ],
    nodes: [
      { id: "event-goal", label: "明确目标" },
      { id: "event-plan", label: "策划方案" },
      { id: "event-checklist", label: "执行清单" },
      { id: "event-recap", label: "活动复盘" },
    ],
  },
]

/** 清洗字段定义：丢掉没有名字的，名字去重（值按名字存 metadata，重名会互相覆盖） */
export function normalizeFieldDefs(raw: unknown): ProjectFieldDef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: ProjectFieldDef[] = []
  for (const f of raw as Partial<ProjectFieldDef>[]) {
    const label = typeof f?.label === "string" ? f.label.trim() : ""
    if (!label || seen.has(label)) continue
    seen.add(label)
    const placeholder = typeof f.placeholder === "string" ? f.placeholder.trim() : ""
    out.push({
      label,
      ...(placeholder ? { placeholder } : {}),
      ...(f.multiline === true ? { multiline: true } : {}),
      ...(f.required === true ? { required: true } : {}),
    })
  }
  return out.length ? out : undefined
}

/** 深拷贝一个流程组，不带中心库跟踪字段（hubId 等只属于全局流程组，项目副本不该继承） */
export function cloneGroupPlain(g: ProjectNodeGroupDef): ProjectNodeGroupDef {
  return {
    id: g.id,
    name: g.name,
    ...(g.description ? { description: g.description } : {}),
    ...(g.workspace ? { workspace: g.workspace } : {}),
    ...(g.fields?.length ? { fields: g.fields.map((f) => ({ ...f })) } : {}),
    nodes: g.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      // 只固化用户改过的提示词；没改的继续跟随代码里的默认提示词，应用升级后自然变好
      ...(n.prompt?.trim() ? { prompt: n.prompt } : {}),
    })),
  }
}

/** 建项时复制所选流程组做项目副本（此后与全局模板脱钩） */
export function snapshotGroups(groups: ProjectNodeGroupDef[]): ProjectNodeGroupDef[] {
  return groups.map(cloneGroupPlain)
}

/** 表单填的值 → 写进 metadata 的键值：只收模板声明过的字段，去首尾空白，空值不写 */
export function fieldValuesToMetadata(
  fields: ProjectFieldDef[] | undefined,
  values: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields ?? []) {
    const raw = values?.[f.label]
    const v = typeof raw === "string" ? raw.trim() : ""
    if (v) out[f.label] = v
  }
  return out
}

/** 必填字段里还没填的名字 */
export function missingRequiredFields(
  fields: ProjectFieldDef[] | undefined,
  values: Record<string, unknown> | undefined,
): string[] {
  return (fields ?? [])
    .filter((f) => f.required)
    .filter((f) => {
      const raw = values?.[f.label]
      return typeof raw !== "string" || !raw.trim()
    })
    .map((f) => f.label)
}

/** 多个流程组的字段合并（同名只留第一个），建项表单用 */
export function mergeGroupFields(groups: ProjectNodeGroupDef[]): ProjectFieldDef[] {
  const seen = new Set<string>()
  const out: ProjectFieldDef[] = []
  for (const g of groups) {
    for (const f of g.fields ?? []) {
      if (seen.has(f.label)) continue
      seen.add(f.label)
      out.push(f)
    }
  }
  return out
}
