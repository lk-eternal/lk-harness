// ── 应用内预览：文档内查找 Ctrl+F（纯函数，电脑端和手机端共用）──────────────────────────
//
// 查找在「拼接文本」上做：界面层把查看器里所有文字节点按顺序拼成一整段，在这段上找关键词，
// 再把命中的偏移换算回「第几个文字节点的第几个字符」，画成高亮。
// 拼接时，两个块之间（段落、表格单元格、代码行）插一个换行；关键词里不会有换行，命中就不会横跨两个块。

/** 最多标出多少处命中：再多没有意义，高亮和跳转都会变慢 */
export const FIND_MAX_MATCHES = 10_000;

export interface FindMatch {
  /** 在拼接文本里的起止偏移，左闭右开 */
  start: number;
  end: number;
}

/** 一段待拼接的文字（一个文字节点） */
export interface FindPiece {
  text: string;
  /** 它和前一段不在同一个块里，中间要隔开 */
  breakBefore: boolean;
  /** 在 <pre> 这类保留换行的地方：换行是真换行，不能当空格 */
  pre?: boolean;
}

/** 一段文字在拼接文本里的位置 */
export interface FindSegment {
  /** 它是传进来的第几段（包括被跳过的空段，下标和传入的数组一一对应） */
  piece: number;
  start: number;
  length: number;
}

export interface FindText {
  text: string;
  segments: FindSegment[];
}

export interface FindPosition {
  piece: number;
  offset: number;
}

/**
 * 换行、制表符、不换行空格在界面上都只是一个空格（Markdown 段落里源文件的硬换行也是）。
 * 逐字替换成空格，长度不变，命中的偏移才对得上原文字节点。
 */
export function normalizeFindText(text: string): string {
  return text.replace(/[\r\n\t\u00a0]/g, " ");
}

/** 把一串文字拼成一整段；空段不进拼接文本，块与块之间隔一个换行 */
export function joinPieces(pieces: readonly FindPiece[]): FindText {
  const segments: FindSegment[] = [];
  let text = "";
  pieces.forEach((p, piece) => {
    if (p.text === "") return;
    if (p.breakBefore && text !== "") text += "\n";
    segments.push({ piece, start: text.length, length: p.text.length });
    text += p.pre ? p.text.replace(/\u00a0/g, " ") : normalizeFindText(p.text);
  });
  return { text, segments };
}

/**
 * 找出 query 在 text 里的所有出现位置：忽略大小写，从左到右，互不重叠，只当普通文字不当正则。
 * query 为空没有命中；到了 limit 就停，capped=true 表示后面还有。
 */
export function findAll(text: string, query: string, limit = FIND_MAX_MATCHES): { matches: FindMatch[]; capped: boolean } {
  const needle = normalizeFindText(query);
  if (needle === "") return { matches: [], capped: false };
  // 用带 i 标志的正则而不是 toLowerCase 后 indexOf：个别字符转小写后长度会变，偏移就错位了
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "giu");
  const matches: FindMatch[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (matches.length >= limit) return { matches, capped: true };
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches, capped: false };
}

/** 二分：最后一个满足 pred 的下标，没有就 -1（pred 对下标单调：前面的为真，后面的为假） */
function lastWhere(count: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * 把一处命中换算成「第几段的第几个字符」。命中的起点落在某一段里（含段首），终点也落在某一段里（含段尾）；
 * 起点正好是上一段的末尾时算下一段的开头，终点正好是下一段的开头时算上一段的末尾。
 * 命中起点或终点不在任何一段里（正好落在块之间的换行上）返回 undefined。
 */
export function locateMatch(segments: readonly FindSegment[], match: FindMatch): { start: FindPosition; end: FindPosition } | undefined {
  const s = lastWhere(segments.length, (i) => segments[i].start <= match.start);
  const e = lastWhere(segments.length, (i) => segments[i].start < match.end);
  if (s < 0 || e < 0) return undefined;
  const from = segments[s];
  const to = segments[e];
  if (match.start >= from.start + from.length || match.end > to.start + to.length) return undefined;
  return {
    start: { piece: from.piece, offset: match.start - from.start },
    end: { piece: to.piece, offset: match.end - to.start },
  };
}

/** 上一个 / 下一个命中，到头了绕回另一头；current 不在范围内（还没选中过）时，下一个是第一个，上一个是最后一个 */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** 查找条上的计数：当前是第几处 / 一共几处；到了上限就在总数后面加 + */
export function formatFindCount(active: number, total: number, capped: boolean): string {
  if (total <= 0) return "无结果";
  return `${active + 1} / ${total}${capped ? "+" : ""}`;
}

/**
 * Ctrl+F 打开查找条时，选中的文字拿来当关键词：只认一小段、单行的；太长或跨行的多半是顺手选的，不是想找的词。
 */
export function seedFromSelection(selected: string, maxLength = 100): string | undefined {
  const text = selected.trim();
  if (text === "" || text.length > maxLength || /[\r\n]/.test(text)) return undefined;
  return text;
}
