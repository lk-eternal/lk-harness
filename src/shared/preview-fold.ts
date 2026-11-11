// ── 应用内预览：代码折叠（纯函数，电脑端和手机端共用）──────────────────────────
//
// 折叠区间用「被藏起来的行」表示：折叠后 start 行仍显示（后面跟一个「⋯ N 行」），start+1 .. end 这些行被藏起来。
// JSON 的 end 取收尾括号的前一行，收尾括号那行仍显示（`},`），不会把同一行上接着的下一个对象也吞掉。
// 行号一律是从 0 开始的下标。

import { splitTextLines } from "./preview-text.js";

export interface FoldRegion {
  /** 折叠后仍显示的那一行（开括号或 `key:` 所在行） */
  start: number;
  /** 折叠后被藏起来的最后一行；一定大于 start */
  end: number;
}

export type FoldLanguage = "json" | "yaml";

/** 哪些语言支持折叠（对应 highlight.js 的语言名） */
export function foldLanguageOf(lang: string | undefined): FoldLanguage | undefined {
  return lang === "json" || lang === "yaml" ? lang : undefined;
}

/** 折叠后藏起来了多少行 */
export function hiddenLineCount(region: FoldRegion): number {
  return region.end - region.start;
}

// ── JSON：按括号配对 ──────────────────────────────────────────────────────────

/**
 * 按括号配对找可折叠的区间。字符串里的括号不算；// 和 /* *\/ 注释里的也不算（tsconfig.json 这类带注释的 JSON 照样能折叠）。
 * 同一行开了好几个括号时只留最外层的那个区间。括号对不上的收尾括号直接忽略，不影响别处。
 * records=true 用于 JSON Lines 排版后的内容：每条记录之间空一行，遇到空行就丢掉没配上的开括号，
 * 一条坏记录不会连累后面所有记录。
 */
export function computeJsonFolds(lines: readonly string[], options: { records?: boolean } = {}): FoldRegion[] {
  const byStart = new Map<number, FoldRegion>();
  const stack: { line: number; ch: string }[] = [];
  let inBlockComment = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (options.records && line.trim() === "") {
      stack.length = 0;
      inBlockComment = false;
      continue;
    }
    let inString = false;
    for (let ci = 0; ci < line.length; ci++) {
      const c = line[ci];
      if (inBlockComment) {
        if (c === "*" && line[ci + 1] === "/") { inBlockComment = false; ci++; }
        continue;
      }
      if (inString) {
        if (c === "\\") ci++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "/" && line[ci + 1] === "/") break;
      else if (c === "/" && line[ci + 1] === "*") { inBlockComment = true; ci++; }
      else if (c === "{" || c === "[") stack.push({ line: li, ch: c });
      else if (c === "}" || c === "]") {
        const top = stack[stack.length - 1];
        if (!top || top.ch !== (c === "}" ? "{" : "[")) continue;
        stack.pop();
        // 开括号和收尾括号之间至少隔着一整行，折叠才有东西可藏
        if (li - top.line >= 2) {
          const end = li - 1;
          const known = byStart.get(top.line);
          if (!known || end > known.end) byStart.set(top.line, { start: top.line, end });
        }
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

// ── YAML：按缩进 ──────────────────────────────────────────────────────────────

interface ContentLine { line: number; indent: number; bareKey: boolean; seqItem: boolean }

function stripYamlComment(text: string): string {
  // 只认「前面是空白的 #」才是注释，`a#b` 和 `"x # y"` 里的不算（引号里的情况极少影响「是否以冒号结尾」的判断，不专门处理）
  const m = /(^|\s)#/.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * 按缩进找可折叠的区间：下一行内容缩进更深，就是一个区间，到缩进回到同级或更浅之前为止。
 * 空行和纯注释行不参与判断（不会把区间截断）。块标量（`script: |`）、多行的列表、嵌套映射都靠缩进自然成块。
 * 例外：`key:` 下面的列表项可以和 key 同级缩进（`key:` 换行 `- a`），这种也算 key 的子内容。
 */
export function computeYamlFolds(lines: readonly string[]): FoldRegion[] {
  const content: ContentLine[] = [];
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const code = stripYamlComment(trimmed).trimEnd();
    content.push({
      line: li,
      indent,
      bareKey: code.endsWith(":") && !code.startsWith("- ") && code !== "-",
      seqItem: code === "-" || code.startsWith("- "),
    });
  }

  const regions: FoldRegion[] = [];
  const stack: number[] = []; // content 的下标，缩进递增（同级的 key 与列表项除外）
  const close = (k: number, upto: number): void => {
    const start = content[k].line;
    const end = content[upto].line;
    if (end > start) regions.push({ start, end });
  };

  for (let k = 0; k < content.length; k++) {
    const cur = content[k];
    while (stack.length) {
      const top = content[stack[stack.length - 1]];
      if (top.indent < cur.indent) break;
      if (top.indent === cur.indent && top.bareKey && cur.seqItem) break;
      close(stack.pop()!, k - 1);
    }
    stack.push(k);
  }
  while (stack.length) close(stack.pop()!, content.length - 1);
  return regions.sort((a, b) => a.start - b.start);
}

// ── 通用 ──────────────────────────────────────────────────────────────────────

/** 一段文本在界面里按行显示（与 toCodeLines 一致：统一换行、文件以换行结尾时不多出一个空行）对应的纯文本行 */
export function displayLines(text: string): string[] {
  const lines = splitTextLines(text);
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

export function computeFolds(lang: FoldLanguage, text: string, options: { records?: boolean } = {}): FoldRegion[] {
  const lines = displayLines(text);
  return lang === "json" ? computeJsonFolds(lines, options) : computeYamlFolds(lines);
}

/** 只留下完全落在前 lineCount 行里的区间（界面最多渲染 MAX_RENDER_LINES 行，超出的区间没法折叠） */
export function clipFolds(regions: readonly FoldRegion[], lineCount: number): FoldRegion[] {
  return regions.filter((r) => r.end < lineCount);
}

/** 折叠状态下要显示的行（下标，升序）：折叠区间里被藏起来的行不在其中，嵌套在里面的折叠也随之不可见 */
export function visibleLines(lineCount: number, regions: readonly FoldRegion[], collapsed: ReadonlySet<number>): number[] {
  if (collapsed.size === 0) return Array.from({ length: lineCount }, (_, i) => i);
  const byStart = new Map<number, FoldRegion>();
  for (const r of regions) if (collapsed.has(r.start)) byStart.set(r.start, r);
  const out: number[] = [];
  for (let i = 0; i < lineCount;) {
    out.push(i);
    const r = byStart.get(i);
    i = r ? r.end + 1 : i + 1;
  }
  return out;
}

export function toggleFold(collapsed: ReadonlySet<number>, start: number): Set<number> {
  const next = new Set(collapsed);
  if (!next.delete(start)) next.add(start);
  return next;
}

export function collapseAll(regions: readonly FoldRegion[]): Set<number> {
  return new Set(regions.map((r) => r.start));
}

/** 展开所有把 line（下标）藏起来的折叠，其余不动；用于定位到某一行时保证它看得见 */
export function revealLine(collapsed: ReadonlySet<number>, regions: readonly FoldRegion[], line: number): Set<number> {
  const next = new Set(collapsed);
  for (const r of regions) if (next.has(r.start) && line > r.start && line <= r.end) next.delete(r.start);
  return next;
}
