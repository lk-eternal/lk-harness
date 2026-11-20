// ── 应用内对话：在会话历史里搜索（Daemon / 桌面端共用）─────────────────────────────
// 界面只加载最近一页，更早的记录只在 Daemon 里，所以搜索在 Daemon 端对完整历史做；
// 命中只带定位用的 id 和命中处的一小段文字，不把整条记录（大的有几百 KB）传回去。

import { chatStreamItems, type AppChatItem } from "./app-chat-types.js";

/** 一次最多给多少条命中；多了让用户把关键词写具体些，不做翻页 */
export const SEARCH_MAX_HITS = 100;
/** 片段里命中处前面带多少字，让人看得出上下文 */
const SNIPPET_LEAD_CHARS = 24;
const SNIPPET_CHARS = 120;

export type ChatSearchKind = "user" | "assistant" | "text" | "question";

export interface ChatSearchHit {
  id: string;
  ts: number;
  kind: ChatSearchKind;
  /** 命中处前后的一小段文字，已折成单行 */
  snippet: string;
}

export interface ChatSearchResult {
  /** 最新的在前 */
  hits: ChatSearchHit[];
  /** 命中多于 SEARCH_MAX_HITS，只给了最新的这些 */
  capped: boolean;
}

/** 搜索词按空白拆开，不分大小写；每个词都要命中 */
export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** 一条记录里搜哪些文字；不搜的类型返回 undefined */
function searchable(item: AppChatItem): { kind: ChatSearchKind; text: string } | undefined {
  switch (item.kind) {
    case "user":
    case "text":
      return { kind: item.kind, text: item.text };
    case "assistant":
      // 只搜回复正文：思考和工具记录默认折叠、占体积的大头，搜到了界面上也看不见
      return { kind: item.kind, text: item.segments.flatMap((s) => (s.type === "reply" ? [s.text] : [])).join("\n\n") };
    case "question":
      return { kind: item.kind, text: [item.text, ...item.options, item.answered ?? ""].join("\n") };
    case "image":
    case "file":
    case "notice":
      return undefined;
    default: {
      // 新增消息类型时在这里编译报错，由写代码的人决定它搜不搜，而不是悄悄搜不到
      const unhandled: never = item;
      return unhandled;
    }
  }
}

function snippetAround(flat: string, at: number): string {
  const start = Math.max(0, at - SNIPPET_LEAD_CHARS);
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** 在聊天流里搜（排队中、还在暂存区的消息不算）：最新的在前，最多 SEARCH_MAX_HITS 条 */
export function searchChatItems(items: AppChatItem[], query: string): ChatSearchResult {
  const tokens = searchTokens(query);
  const hits: ChatSearchHit[] = [];
  if (tokens.length === 0) return { hits, capped: false };

  const stream = chatStreamItems(items);
  for (let i = stream.length - 1; i >= 0; i--) {
    const found = searchable(stream[i]);
    if (!found) continue;
    const flat = found.text.replace(/\s+/g, " ").trim();
    const lower = flat.toLowerCase();
    if (!tokens.every((t) => lower.includes(t))) continue;
    if (hits.length === SEARCH_MAX_HITS) return { hits, capped: true };
    hits.push({ id: stream[i].id, ts: stream[i].ts, kind: found.kind, snippet: snippetAround(flat, lower.indexOf(tokens[0])) });
  }
  return { hits, capped: false };
}
