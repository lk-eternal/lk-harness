// ── 应用内对话：历史分页（Daemon / 桌面端 / 手机端共用）──────────────────────
// 打开会话不再把整段历史（最多 1000 条）一次拉过来渲染：只要最近一页，更早的点「加载更早」再取。
// 渲染一张回复卡要解析它全部回复文字（Markdown + 代码高亮），大会话整段渲染要好几秒，手机上更慢；
// 而体积的大头是思考和工具记录（真实的大会话里思考文字占 7 成），整段传到手机上也很重。

import type { AppChatItem } from "./app-chat-types.js";

/** 打开会话时先要多少条 */
export const HISTORY_PAGE_LIMIT = 30;
/** 一页最多要多少条：服务端的上限，不信任请求里的数字 */
export const HISTORY_PAGE_LIMIT_MAX = 200;
/**
 * 一页的体积上限（序列化后的字符数）。单张回复卡含全部思考和工具记录，大的有几百 KB，
 * 只按条数分页挡不住，所以条数没到、体积先到也收页。一页至少给一条。
 */
export const HISTORY_PAGE_MAX_CHARS = 512 * 1024;

/** 取哪一页：不带 limit 是整段历史（老版本手机 App 的请求就是这样，没有「加载更早」，不能悄悄截断它们的历史） */
export interface HistoryQuery {
  limit?: number;
  /** 取这条之前的记录；与 beforeTs 一起给，id 找不到（被移除了）时按 ts 定位 */
  beforeId?: string;
  beforeTs?: number;
}

export interface HistoryPage {
  items: AppChatItem[];
  /** 这一页之前还有更早的记录 */
  hasMore: boolean;
}

/** 已加载窗口的起点：「加载更早」从它之前取 */
export interface HistoryCursor {
  id: string;
  ts: number;
}

/** 请求体（来自界面或手机，不可信）→ 干净的查询；字段不合法就当没给 */
export function parseHistoryQuery(raw: unknown): HistoryQuery {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const query: HistoryQuery = {};
  if (typeof src.limit === "number" && Number.isFinite(src.limit) && src.limit >= 1) {
    query.limit = Math.min(Math.floor(src.limit), HISTORY_PAGE_LIMIT_MAX);
  }
  if (typeof src.beforeId === "string" && src.beforeId) query.beforeId = src.beforeId;
  if (typeof src.beforeTs === "number" && Number.isFinite(src.beforeTs)) query.beforeTs = src.beforeTs;
  return query;
}

/** 游标之前的记录个数（游标本身不含）：按 id 找，找不到再按 ts（记录按 ts 有序） */
function endBeforeCursor(all: readonly AppChatItem[], query: HistoryQuery): number {
  if (query.beforeId === undefined && query.beforeTs === undefined) return all.length;
  if (query.beforeId !== undefined) {
    const at = all.findIndex((it) => it.id === query.beforeId);
    if (at >= 0) return at;
  }
  if (query.beforeTs === undefined) return all.length;
  const at = all.findIndex((it) => it.ts >= query.beforeTs!);
  return at >= 0 ? at : all.length;
}

/** 从完整历史里切出一页：游标之前（缺省是末尾）的最近若干条，条数和体积都有上限，一页至少一条 */
export function pageChatHistory(all: readonly AppChatItem[], query: HistoryQuery = {}): HistoryPage {
  if (query.limit === undefined) return { items: [...all], hasMore: false };
  const end = endBeforeCursor(all, query);
  let start = end;
  let chars = 0;
  while (start > 0 && end - start < query.limit) {
    const size = JSON.stringify(all[start - 1]).length;
    if (start < end && chars + size > HISTORY_PAGE_MAX_CHARS) break;
    chars += size;
    start--;
  }
  return { items: all.slice(start, end), hasMore: start > 0 };
}

/** 一页的起点，作为下一次「加载更早」的游标；空页没有 */
export function historyCursorOf(page: readonly AppChatItem[]): HistoryCursor | undefined {
  const first = page[0];
  return first ? { id: first.id, ts: first.ts } : undefined;
}

/**
 * 实时事件里的记录落在还没加载的更早区域（比窗口起点更早、列表里又没有它）：不并入。
 * 并进去它就成了列表里的第一条，它和窗口之间的记录被跳过；翻到那里时服务端给的本来就是最新的。
 */
export function isBeyondLoadedWindow(
  item: Pick<AppChatItem, "id" | "ts">,
  cursor: HistoryCursor | undefined,
  loaded: readonly Pick<AppChatItem, "id">[],
): boolean {
  return !!cursor && item.ts < cursor.ts && !loaded.some((it) => it.id === item.id);
}

/**
 * 重新拉到最近一页（实时流重连后补漏）时，替换列表里对应的那一段；
 * 用户已经往前翻出来的更早记录保留，不因为一次补漏被清掉。拉回来是空的说明会话被清空了。
 */
export function replaceHistoryTail(prev: readonly AppChatItem[], tail: readonly AppChatItem[]): AppChatItem[] {
  const first = tail[0];
  if (!first) return [];
  return [...prev.filter((it) => it.ts < first.ts), ...tail];
}

/**
 * 补漏拉回来的最近一页，能不能和列表里已有的部分接上（只换尾巴，保住用户往前翻出来的更早记录）：
 * 已加载窗口的起点确实比这一页更早（翻过），并且列表末尾和这一页有重叠。
 * 接不上（断线期间的新消息多到一页装不下）就不能只换尾巴，中间会缺一段，只能整个换成这一页。
 */
export function keepsLoadedHistory(
  cursor: HistoryCursor | undefined,
  prev: readonly Pick<AppChatItem, "ts">[],
  tail: readonly Pick<AppChatItem, "ts">[],
): boolean {
  const first = tail[0];
  const last = prev[prev.length - 1];
  return !!cursor && !!first && !!last && cursor.ts < first.ts && last.ts >= first.ts;
}
