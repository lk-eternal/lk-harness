// 项目缺陷监控的纯规则：查哪张表、怎么解析结果、怎么去重、发给谁看的文案怎么写。
// 不读写文件、不起进程（那些在 daemon-bug-watch.ts / project-bug-watch-state.ts），所以能脱离飞书项目直接测。
//
// 数据来源：飞书项目空间 wk-dm 的「bug 管理」表，按「关联产品需求」（需求名称，精确匹配）过滤。
// 按「负责人」过滤不可靠（试过：需求下的缺陷常常没分配给当前登录人），所以不过滤，只把负责人展示出来。

export const BUG_WATCH_SPACE = "wk-dm";
export const BUG_TABLE = "bug 管理";
export const BUG_QUERY_LIMIT = 100;
/** 单个项目最多记住多少个已见过的缺陷 id（超出丢最早的）：只是防止状态文件无限长 */
export const BUG_SEEN_CAP = 1000;
/** 群里通知最多列几条，其余写「等 N 个」 */
export const BUG_NOTICE_MAX_LINES = 5;
/** 投给项目会话的消息最多列几条（久未检查后一次冒出很多时，别把会话上下文灌满） */
export const BUG_SESSION_MAX_LINES = 30;

export interface BugRecord {
  id: string;
  name: string;
  status: string;
  /** 当前负责人（展示用，可能为空） */
  assignee: string;
  priority: string;
}

/** 每个项目的监控记录 */
export interface BugWatchEntry {
  /** 需求 id（storyUrl 解析而来）；项目换了需求链接就要重新取名称、重新建基线 */
  storyId: string;
  /** 需求名称，查询用；缓存起来，不用每轮都问一次 */
  storyName?: string;
  /** 已见过的缺陷：id → 最近一次看到的状态 */
  seen: Record<string, string>;
  /** 建立基线的时间（开启监控后第一次成功查询） */
  baselineAt: number;
  checkedAt: number;
}

export type BugWatchState = Record<string, BugWatchEntry>;

// ── 需求链接 ───────────────────────────────────────────

/**
 * 只支持 wk-dm 空间的「产品需求」链接：缺陷表和「关联产品需求」字段都是这个空间的约定。
 * 技术需求、别的空间的需求不在支持范围（查不到关联的缺陷，开了也只会一直空转）。
 */
export function parseWatchableStoryUrl(url: string | undefined): { storyId: string } | undefined {
  const m = /^https?:\/\/project\.feishu\.cn\/([^/\s?#]+)\/story\/detail\/(\d+)/i.exec((url ?? "").trim());
  if (!m || m[1] !== BUG_WATCH_SPACE) return undefined;
  return { storyId: m[2] };
}

/** 设置页 / 日志里用：这个项目为什么不能监控 */
export function bugWatchUnsupportedReason(storyUrl: string | undefined): string | undefined {
  if (!storyUrl?.trim()) return "项目没有填飞书项目需求链接";
  if (!parseWatchableStoryUrl(storyUrl)) return `需求链接不是 ${BUG_WATCH_SPACE} 空间的产品需求（只支持 https://project.feishu.cn/${BUG_WATCH_SPACE}/story/detail/…）`;
  return undefined;
}

// ── 查询 ───────────────────────────────────────────────

/**
 * 按需求名称查关联缺陷的 MQL。需求名称原样放进字符串字面量，含引号 / 反斜杠 / 换行时没法保证转义正确，
 * 宁可不查（返回 undefined）也不拼出一条可能查错东西的语句。
 */
export function buildBugQuery(storyName: string): string | undefined {
  const name = storyName.trim();
  if (!name || /['"\\\r\n`]/.test(name)) return undefined;
  return (
    "SELECT `工作项id`, `名称`, `状态`, `当前负责人`, `优先级` " +
    `FROM \`${BUG_WATCH_SPACE}\`.\`${BUG_TABLE}\` ` +
    `WHERE array_contains(\`关联产品需求\`, '${name}') LIMIT ${BUG_QUERY_LIMIT}`
  );
}

type Field = { key?: string; value_type?: string; value?: Record<string, unknown> };

function fieldText(f: Field): string {
  const v = f.value ?? {};
  switch (f.value_type) {
    case "string_value":
      return typeof v.string_value === "string" ? v.string_value.trim() : "";
    case "long_value":
      return typeof v.long_value === "number" || typeof v.long_value === "string" ? String(v.long_value) : "";
    case "key_label_value": {
      const kl = v.key_label_value as { label?: string } | undefined;
      return kl?.label?.trim() ?? "";
    }
    case "key_label_value_list": {
      const list = (v.key_label_value_list as Array<{ label?: string }> | undefined) ?? [];
      return list.map((x) => x.label?.trim() ?? "").filter(Boolean).join("、");
    }
    case "user_value_list": {
      const list = (v.user_value_list as Array<{ name_cn?: string; name_en?: string }> | undefined) ?? [];
      return list.map((u) => u.name_cn?.trim() || u.name_en?.trim() || "").filter(Boolean).join("、");
    }
    default:
      return "";
  }
}

/** 解析 `meegle workitem query` 的 JSON；结构不对一律当没有结果（由调用方区分「查失败」和「没有缺陷」） */
export function parseBugRows(raw: unknown): BugRecord[] {
  const data = (raw as { data?: Record<string, unknown> } | null | undefined)?.data;
  const rows = data?.["1"];
  if (!Array.isArray(rows)) return [];
  const out: BugRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<{ moql_field_list?: Field[] }>) {
    const byKey = new Map<string, string>();
    for (const f of row?.moql_field_list ?? []) {
      if (typeof f?.key === "string") byKey.set(f.key, fieldText(f));
    }
    const id = byKey.get("work_item_id") ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: byKey.get("name") || "（无标题）",
      status: byKey.get("work_item_status") ?? "",
      assignee: byKey.get("current_status_operator") ?? "",
      priority: byKey.get("priority") ?? "",
    });
  }
  return out;
}

/** 结果的结构是不是「查询成功」的样子：区分「没有缺陷」和「返回了看不懂的东西」 */
export function looksLikeBugQueryResult(raw: unknown): boolean {
  const data = (raw as { data?: Record<string, unknown> } | null | undefined)?.data;
  return !!data && typeof data === "object" && Array.isArray(data["1"] ?? []);
}

// ── 去重 ───────────────────────────────────────────────

export interface BugDiff {
  /** 没有记录：这次只建基线，不算新缺陷（开启监控时已有的缺陷不一次性刷屏） */
  baseline: boolean;
  fresh: BugRecord[];
  next: BugWatchEntry;
}

/**
 * 对比上次记录。只有「从没见过的 id」算新缺陷；已见过的状态变了只更新记录，不再通知
 * （项目自己的 AI 去改缺陷状态时不该再把消息发回给它）。
 * 缺陷暂时从查询结果里消失（比如被取消关联）后又出现，不会当作新缺陷重复通知。
 */
export function diffBugs(
  prev: BugWatchEntry | undefined,
  storyId: string,
  storyName: string,
  bugs: readonly BugRecord[],
  now: number,
): BugDiff {
  const sameStory = prev && prev.storyId === storyId;
  const seen: Record<string, string> = sameStory ? { ...prev.seen } : {};
  const fresh = sameStory ? bugs.filter((b) => !(b.id in prev.seen)) : [];
  for (const b of bugs) seen[b.id] = b.status;

  const ids = Object.keys(seen);
  if (ids.length > BUG_SEEN_CAP) {
    for (const id of ids.slice(0, ids.length - BUG_SEEN_CAP)) delete seen[id];
  }
  return {
    baseline: !sameStory,
    fresh,
    next: {
      storyId,
      storyName,
      seen,
      baselineAt: sameStory ? prev.baselineAt : now,
      checkedAt: now,
    },
  };
}

// ── 文案 ───────────────────────────────────────────────

function bugLine(b: BugRecord): string {
  const meta = [b.status, b.assignee ? `负责人：${b.assignee}` : "负责人：未分配"].filter(Boolean).join("，");
  const pri = b.priority ? `[${b.priority}] ` : "";
  return `${pri}${b.name}（#${b.id}，${meta}）`;
}

function stamp(now: Date): string {
  return now.toLocaleString("zh-CN", { hour12: false });
}

/** 投给项目会话的消息：一行标题 + 新增缺陷清单 */
export function formatBugsForSession(projectName: string, fresh: readonly BugRecord[], now: Date = new Date()): string {
  const shown = fresh.slice(0, BUG_SESSION_MAX_LINES);
  const rest = fresh.length - shown.length;
  return [
    `🐞 缺陷监控「${projectName}」：新增 ${fresh.length} 个缺陷（${stamp(now)}）`,
    "",
    ...shown.map((b) => `- ${bugLine(b)}`),
    ...(rest > 0 ? [`- …另有 ${rest} 个没有列出，可到飞书项目「${BUG_TABLE}」表里按需求查看`] : []),
  ].join("\n");
}

/** 发到项目群的一条简短通知（给人看，不给 AI） */
export function formatBugsGroupNotice(projectName: string, fresh: readonly BugRecord[]): string {
  const shown = fresh.slice(0, BUG_NOTICE_MAX_LINES);
  const rest = fresh.length - shown.length;
  return [
    `🐞 **${projectName}** 新增 ${fresh.length} 个缺陷：`,
    ...shown.map((b) => `- ${bugLine(b)}`),
    ...(rest > 0 ? [`- …等 ${rest} 个`] : []),
    "已转给项目会话，AI 会先看一下。",
  ].join("\n");
}
