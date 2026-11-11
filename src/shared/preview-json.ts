// ── 应用内预览：JSON 格式化（纯函数，电脑端和手机端共用）────────────────────────
//
// 格式化只重新排版（缩进、换行），不改任何一个 token 的写法：
// 不能走 JSON.parse + JSON.stringify，那样会丢大整数的精度（12345678901234567890 变成 12345678901234567000）、
// 把「像整数的键」提到最前面、吞掉重复的键。这里按词法切开再排版，数字、字符串都原样输出。

import { fileExt } from "./preview-kinds.js";
import { splitTextLines } from "./preview-text.js";

export interface JsonErrorInfo {
  message: string;
  /** 从 1 开始；定位不到（比如空文件）就没有 */
  line?: number;
  column?: number;
}

export type JsonFormatResult =
  | { ok: true; text: string; /** jsonl：这些行不是合法 JSON，已原样保留（行号从 1 开始） */ skippedLines: number[] }
  | ({ ok: false } & JsonErrorInfo);

/** 这个文件能不能格式化，按哪种规则：json 整个是一个值；jsonl 每行一条记录。jsonc / json5 含注释和尾逗号，不是标准 JSON，不提供 */
export type JsonFormatKind = "json" | "jsonl";

export function jsonFormatKind(fileName: string): JsonFormatKind | undefined {
  const ext = fileExt(fileName);
  if (ext === "json") return "json";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  return undefined;
}

/**
 * 打开时要不要直接显示格式化后的样子：只对「几乎挤成一行」的 json 这样做（接口返回、压缩过的配置）。
 * 已经排好版的文件原样显示：格式化会把手写的短数组拆成多行、把 4 空格缩进改成 2 空格，不该未经允许就改。
 * 从对话里点进来要定位到某一行时也原样显示，格式化后行号对不上。
 */
export function shouldDefaultToFormatted(kind: JsonFormatKind | undefined, text: string, hasTargetLine: boolean): boolean {
  if (kind !== "json" || hasTargetLine || text.length <= 200) return false;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return text.length / lines > 120;
}

// ── 找错 ──────────────────────────────────────────────────────────────────────

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL_RE = /true|false|null/y;
const HEX4_RE = /[0-9a-fA-F]{4}/y;

interface RawError { index: number; message: string }

/** 字符串从 start（引号）开始，返回结束引号之后的位置；写法不对返回错误 */
function scanString(text: string, start: number): number | RawError {
  const n = text.length;
  let i = start + 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) return i + 1;
    if (c < 0x20) return { index: i, message: "字符串里不能直接换行或放控制字符，要写成转义（\\n）" };
    if (c === 0x5c) {
      const e = text[i + 1];
      if (e === undefined) break;
      if (e === "u") {
        HEX4_RE.lastIndex = i + 2;
        if (!HEX4_RE.test(text)) return { index: i, message: "\\u 后面要跟 4 位十六进制数" };
        i += 6;
        continue;
      }
      if (!`"\\/bfnrt`.includes(e)) return { index: i, message: `不认识的转义 \\${e}` };
      i += 2;
      continue;
    }
    i++;
  }
  return { index: start, message: "字符串没有结束（缺少右引号）" };
}

/**
 * 严格按 JSON 语法找第一处错误（找不到返回 undefined）。迭代实现，嵌套再深也不会爆栈。
 * 是否合法以 JSON.parse 为准；这里只负责说清楚错在哪，所以只在 JSON.parse 抛错之后才用。
 */
export function findJsonError(text: string): RawError | undefined {
  const n = text.length;
  const stack: string[] = [];
  type Expect = "value" | "valueOrClose" | "keyOrClose" | "key" | "colon" | "commaOrClose" | "end";
  let expect: Expect = "value";
  let i = 0;
  const after = (): Expect => (stack.length ? "commaOrClose" : "end");

  for (;;) {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    if (i >= n) {
      if (expect === "end") return undefined;
      return { index: n, message: n === 0 || text.trim() === "" ? "文件是空的" : "内容在中途结束了（括号或引号没有配对）" };
    }
    const c = text[i];

    // 注释和单引号是最常见的「不是标准 JSON」，单独说清楚
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      return { index: i, message: "含有注释，不是标准 JSON（JSONC 一类的写法）" };
    }

    switch (expect) {
      case "value":
      case "valueOrClose": {
        if (expect === "valueOrClose" && c === "]") { stack.pop(); i++; expect = after(); break; }
        if (c === "{") { stack.push("{"); i++; expect = "keyOrClose"; break; }
        if (c === "[") { stack.push("["); i++; expect = "valueOrClose"; break; }
        if (c === '"') {
          const r = scanString(text, i);
          if (typeof r !== "number") return r;
          i = r; expect = after();
          break;
        }
        NUMBER_RE.lastIndex = i;
        const num = NUMBER_RE.exec(text);
        if (num) { i += num[0].length; expect = after(); break; }
        LITERAL_RE.lastIndex = i;
        const lit = LITERAL_RE.exec(text);
        if (lit) { i += lit[0].length; expect = after(); break; }
        if (c === "'") return { index: i, message: "字符串要用双引号，不能用单引号" };
        if (c === "]" || c === "}" || c === ",") {
          return { index: i, message: c === "," ? "这里多了一个逗号" : "括号前多了逗号，或者缺少值（标准 JSON 不允许尾逗号）" };
        }
        return { index: i, message: `这里应该是一个值，却是「${c}」` };
      }
      case "keyOrClose":
      case "key": {
        if (expect === "keyOrClose" && c === "}") { stack.pop(); i++; expect = after(); break; }
        if (c === '"') {
          const r = scanString(text, i);
          if (typeof r !== "number") return r;
          i = r; expect = "colon";
          break;
        }
        if (c === "}") return { index: i, message: "括号前多了逗号（标准 JSON 不允许尾逗号）" };
        if (c === "'") return { index: i, message: "属性名要用双引号，不能用单引号" };
        return { index: i, message: "属性名必须用双引号括起来" };
      }
      case "colon": {
        if (c !== ":") return { index: i, message: "属性名后面缺少冒号" };
        i++; expect = "value";
        break;
      }
      case "commaOrClose": {
        const top = stack[stack.length - 1];
        if (c === ",") { i++; expect = top === "{" ? "key" : "value"; break; }
        if ((top === "{" && c === "}") || (top === "[" && c === "]")) { stack.pop(); i++; expect = after(); break; }
        return { index: i, message: top === "{" ? "这里应该是逗号或右花括号 }" : "这里应该是逗号或右方括号 ]" };
      }
      case "end":
        return { index: i, message: "一个完整的 JSON 之后还有多余的内容" };
    }
  }
}

/** 字符偏移 → 行号、列号（都从 1 开始），行按 \n 切，\r\n 的 \r 算在上一行末尾 */
export function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const end = Math.min(Math.max(index, 0), text.length);
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < end; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: end - last };
}

/** 能不能被 JSON.parse 接受 */
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function describeFailure(text: string): JsonErrorInfo {
  const found = findJsonError(text);
  if (found) return { message: found.message, ...lineColumnAt(text, found.index) };
  // 理论上走不到：JSON.parse 拒绝了而这里没找到错
  return { message: "不是合法的 JSON" };
}

// ── 排版 ──────────────────────────────────────────────────────────────────────

const PLAIN_RE = /[^\s,:[\]{}"]+/y;
const INDENT = "  ";

/** 把一段已经确认合法的 JSON 重新排版：每层缩进两个空格，空对象 / 空数组保持 {} / [] */
export function reindentJson(text: string): string {
  const out: string[] = [];
  const pads: string[] = [""];
  const pad = (depth: number): string => {
    while (pads.length <= depth) pads.push(pads[pads.length - 1] + INDENT);
    return pads[depth];
  };
  const n = text.length;
  let depth = 0;
  let breakBefore = false;
  let justOpened = false;
  let i = 0;

  const startToken = (): void => {
    if (breakBefore) { out.push("\n", pad(depth)); breakBefore = false; }
  };

  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      // 调用方保证 text 合法；j < n 是兜底，万一传来没结束的字符串也不会死循环
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      startToken();
      out.push(text.slice(i, j + 1));
      justOpened = false;
      i = j + 1;
    } else if (c === "{" || c === "[") {
      startToken();
      out.push(c);
      depth++;
      breakBefore = true;
      justOpened = true;
      i++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (!justOpened) out.push("\n", pad(depth));
      breakBefore = false;
      justOpened = false;
      out.push(c);
      i++;
    } else if (c === ",") {
      out.push(",");
      breakBefore = true;
      justOpened = false;
      i++;
    } else if (c === ":") {
      out.push(": ");
      justOpened = false;
      i++;
    } else {
      PLAIN_RE.lastIndex = i;
      const m = PLAIN_RE.exec(text);
      if (!m) { i++; continue; }
      startToken();
      out.push(m[0]);
      justOpened = false;
      i += m[0].length;
    }
  }
  return out.join("");
}

/** 格式化一个 JSON 文件。不合法就返回错在哪，调用方继续显示原文 */
export function formatJson(text: string): JsonFormatResult {
  if (!parses(text)) return { ok: false, ...describeFailure(text) };
  return { ok: true, text: reindentJson(text), skippedLines: [] };
}

/**
 * 格式化 JSON Lines：每行一条记录，各自排版，记录之间空一行。
 * 不合法的行原样保留（日志文件里夹杂几行非 JSON 很常见），只有一条合法记录都没有才算失败。
 */
export function formatJsonLines(text: string): JsonFormatResult {
  const lines = splitTextLines(text);
  const pieces: string[] = [];
  const skippedLines: number[] = [];
  let valid = 0;
  let firstBad: { index: number; raw: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (parses(raw)) {
      pieces.push(reindentJson(raw));
      valid++;
    } else {
      pieces.push(raw);
      skippedLines.push(i + 1);
      firstBad ??= { index: i, raw };
    }
  }
  if (valid === 0) {
    if (!firstBad) return { ok: false, message: "文件是空的" };
    const info = describeFailure(firstBad.raw);
    return { ok: false, message: info.message, line: firstBad.index + 1, column: info.column };
  }
  return { ok: true, text: pieces.join("\n\n"), skippedLines };
}

export function formatJsonFor(kind: JsonFormatKind, text: string): JsonFormatResult {
  return kind === "jsonl" ? formatJsonLines(text) : formatJson(text);
}
