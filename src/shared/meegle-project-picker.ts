import { meegleAuthenticated, runMeegleJson } from "./meegle-cli.js"

const PROJECT_SPACE = "wk-dm"
const CACHE_TTL_MS = 10 * 60 * 1000

const STORY_MQL =
  "SELECT `工作项id`, `需求名称`, `需求状态` FROM `wk-dm`.`产品需求` WHERE any_match(all_participate_persons(), x -> x = current_login_user()) AND in_progress_nodes_name() is not null LIMIT 50"
const TECH_MQL =
  "SELECT `工作项id`, `名称` FROM `wk-dm`.`技术需求` WHERE any_match(all_participate_persons(), x -> x = current_login_user()) AND in_progress_nodes_name() is not null LIMIT 50"

export type FeishuProjectPickItem = {
  projectKey: string
  simpleName: string
  workItemId: string
  workItemTypeKey: string
  urlPathType: string
  typeLabel: string
  name: string
  status?: string
  pickId: string
}

export type FeishuProjectFormDefaults = {
  name: string
  storyUrl: string
  relatedDocs: string
}

const listCache = new Map<string, { at: number; items: FeishuProjectPickItem[] }>()

type MoqlRow = Record<string, string | number | undefined>

function parseMoqlResponse(raw: unknown): MoqlRow[] {
  const j = raw as { data?: Record<string, { moql_field_list?: Array<{
    key: string
    value_type: string
    value: Record<string, unknown>
  }> }[]> }
  const rows = j.data?.["1"] ?? []
  return rows.map((row) => {
    const m: MoqlRow = {}
    for (const f of row.moql_field_list ?? []) {
      if (f.value_type === "string_value") m[f.key] = f.value.string_value as string
      else if (f.value_type === "long_value") m[f.key] = f.value.long_value as number
      else if (f.value_type === "key_label_value_list") {
        const list = f.value.key_label_value_list as Array<{ label?: string }> | undefined
        m[f.key] = list?.[0]?.label
      }
    }
    return m
  })
}

function pickLabel(item: FeishuProjectPickItem): string {
  const status = item.status ? ` · ${item.status}` : ""
  return `[${item.typeLabel}] ${item.name}${status}`.slice(0, 95)
}

export function feishuProjectDetailUrl(simpleName: string, urlPathType: string, workItemId: string): string {
  return `https://project.feishu.cn/${simpleName}/${urlPathType}/detail/${workItemId}`
}

export function mergeRelatedDocUrls(...parts: (string | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (!part?.trim()) continue
    const urls = extractHttpUrls(part)
    for (const u of urls) {
      const norm = u.replace(/[?#].*$/, "")
      if (seen.has(norm)) continue
      seen.add(norm)
      out.push(u)
    }
  }
  return out.join(", ")
}

export function extractHttpUrls(text: string): string[] {
  const urls: string[] = []
  const re = /https?:\/\/[^\s)\]"'<>]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    urls.push(m[0].replace(/[.,;]+$/, ""))
  }
  return urls
}

function fieldString(fields: Array<{ key: string; value?: unknown }>, key: string): string | undefined {
  const f = fields.find((x) => x.key === key)
  const v = f?.value
  if (typeof v === "string" && v.trim()) return v.trim()
  return undefined
}

async function queryWorkItems(mql: string): Promise<MoqlRow[]> {
  const raw = await runMeegleJson([
    "workitem", "query",
    "--project-key", PROJECT_SPACE,
    "-P", JSON.stringify({ mql }),
    "-o", "json",
  ], 12_000)
  return parseMoqlResponse(raw)
}

function rowToPickItem(row: MoqlRow, typeLabel: string, urlPathType: string, workItemTypeKey: string): FeishuProjectPickItem | null {
  const id = row.work_item_id
  const name = (row.name as string | undefined)?.trim()
  if (id == null || !name) return null
  const workItemId = String(id)
  const pickId = `${workItemId}:${urlPathType}`
  return {
    projectKey: PROJECT_SPACE,
    simpleName: PROJECT_SPACE,
    workItemId,
    workItemTypeKey,
    urlPathType,
    typeLabel,
    name,
    status: typeof row.work_item_status === "string" ? row.work_item_status : undefined,
    pickId,
  }
}

export async function listFeishuProjectsForPicker(cacheKey: string): Promise<FeishuProjectPickItem[] | null> {
  if (!cacheKey) return null
  const hit = listCache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items

  if (!(await meegleAuthenticated())) return null

  try {
    const [storyRows, techRows] = await Promise.all([
      queryWorkItems(STORY_MQL),
      queryWorkItems(TECH_MQL),
    ])
    const items: FeishuProjectPickItem[] = []
    const seen = new Set<string>()
    for (const row of storyRows) {
      const item = rowToPickItem(row, "产品需求", "story", "story")
      if (item && !seen.has(item.pickId)) {
        seen.add(item.pickId)
        items.push(item)
      }
    }
    for (const row of techRows) {
      const item = rowToPickItem(row, "技术需求", "t1024", "6821913e7366d5de6fac5873")
      if (item && !seen.has(item.pickId)) {
        seen.add(item.pickId)
        items.push(item)
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    listCache.set(cacheKey, { at: Date.now(), items })
    return items
  } catch {
    return null
  }
}

export function feishuPickOptionLabels(items: FeishuProjectPickItem[]): Array<{ pickId: string; label: string }> {
  return items.map((item) => ({ pickId: item.pickId, label: pickLabel(item) }))
}

const STORY_DOC_FIELDS = [ "wiki", "field_1" ]
const TECH_DOC_FIELDS = [ "field_d63b3b", "field_c4b7b7" ]

export async function resolveFeishuProjectFormDefaults(item: FeishuProjectPickItem): Promise<FeishuProjectFormDefaults | null> {
  const docFields = item.urlPathType === "story" ? STORY_DOC_FIELDS : TECH_DOC_FIELDS
  try {
    const raw = await runMeegleJson([
      "workitem", "get",
      "--project-key", item.projectKey,
      "--work-item-id", item.workItemId,
      "--fields", docFields.join(","),
      "-o", "json",
    ], 12_000) as {
      work_item_attribute?: { work_item_name?: string }
      work_item_fields?: Array<{ key: string; value?: unknown }>
    }
    const name = raw.work_item_attribute?.work_item_name?.trim()
    if (!name) return null
    const fields = raw.work_item_fields ?? []
    const docParts = docFields.map((k) => fieldString(fields, k))
    const storyUrl = feishuProjectDetailUrl(item.simpleName, item.urlPathType, item.workItemId)
    const relatedDocs = mergeRelatedDocUrls(...docParts)
    return { name, storyUrl, relatedDocs }
  } catch {
    return null
  }
}

export function findFeishuPickItem(
  items: FeishuProjectPickItem[] | undefined,
  pickId: string,
): FeishuProjectPickItem | undefined {
  return items?.find((x) => x.pickId === pickId)
}
