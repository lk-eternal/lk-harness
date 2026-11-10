// ── 应用内预览：从对话文字里找文件路径（纯函数）──────────────────────────────────
//
// Agent 的回复里常有「已写入 D:\work\report.xlsx」「见 src/app.ts:42」这类路径。这里只负责「长得像路径」的识别，
// 并不保证文件存在、也不保证能看——识别出来的候选要交给主进程检查（存在、有权限）后才显示成可点击。
// 宁可漏认也不要乱认：普通文字里的 and/or、2024/03/15、v1.2.3 不应该被当成路径去打扰文件系统。

export interface PathRef {
  path: string;
  /** 路径后面带的行号（:42、:42:7、#L42、#L42-L50 取起点） */
  line?: number;
}

export interface PathMention extends PathRef {
  /** 在原文里的位置，[start, end)，包含行号后缀 */
  start: number;
  end: number;
}

/** 一段文字里最多认出多少个：再多也不会有人逐个点 */
export const MAX_PATH_MENTIONS = 100;

const MAX_LINE = 10_000_000;

// 扩展名：1–10 个字母数字，后面不能再接路径字符或「.字母数字」（避免把 a.b\c.txt 在 a.b 处截断，也避免吃进句末的句号）
const EXT = String.raw`\.[A-Za-z0-9]{1,10}(?![\w\\/-]|\.\w)`;
// Windows 绝对路径：盘符开头，中间可以有中文和点；纯文字里没法判断空格，所以不含空白。
// 盘符前面不能是字母数字（https://x 里的 s:/ 不是盘符），盘符后面不能再跟斜杠（网址的 ://）
const WIN_ABS = String.raw`(?<![\w.-])[A-Za-z]:[\\/](?![\\/])[^\s<>"|?*]*?${EXT}`;
// 相对路径或 POSIX 绝对路径：至少有一级目录，最后一段要有扩展名；前面不能是路径字符（避免从网址、盘符路径中间切出一段）
const REL = String.raw`(?<![\w/\\.:@~-])(?:\.{1,2}[\\/]|/)?(?:[\w.@+-]+[\\/])+[\w.@+-]*${EXT}`;
const LINE = String.raw`(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?`;

function lineOf(a: string | undefined, b: string | undefined): number | undefined {
  const n = Number(a ?? b);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE ? n : undefined;
}

/** 一段文字最多扫描多少字符：回复是不可信的输入，超长文本里恶意构造的内容不能拖慢界面 */
const MAX_SCAN_LENGTH = 20_000;

/** 在普通文字里找路径（不含空白的写法；带空格的路径只在行内代码里认） */
export function findPathMentions(text: string): PathMention[] {
  const out: PathMention[] = [];
  const re = new RegExp(`(${WIN_ABS}|${REL})${LINE}`, "g");
  for (const m of (text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text).matchAll(re)) {
    const line = lineOf(m[2], m[3]);
    out.push({ path: m[1], ...(line ? { line } : {}), start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_PATH_MENTIONS) break;
  }
  return out;
}

const BAD_CHARS = /[<>"|?*\0\r\n\t]/;
const MAX_CODE_LENGTH = 400;

/**
 * 行内代码整体是不是一个路径（`src/app.ts:42`、`D:\My Docs\a.docx`、`package.json`）。
 * 比普通文字宽松：允许没有目录的文件名（package.json）、没有扩展名的文件（Makefile）要有目录、绝对路径里可以有空格。
 */
export function parsePathRef(code: string): PathRef | undefined {
  const text = code.trim();
  if (text === "" || text.length > MAX_CODE_LENGTH || BAD_CHARS.test(text) || text.includes("://")) return undefined;

  let path = text;
  let line: number | undefined;
  const suffix = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(text);
  // 盘符后面的冒号（C:\x）后面不是数字，不会被当成行号；C:12 这种不是路径，下面的形状检查会拦掉
  if (suffix) {
    path = suffix[1];
    line = lineOf(suffix[2], suffix[3]);
  }

  const absolute = /^[A-Za-z]:[\\/]/.test(path) || /^\/[^/\s]/.test(path);
  if (/\s/.test(path) && !absolute) return undefined;
  if (path.startsWith("-") || /[\\/]$/.test(path)) return undefined;

  const hasDir = /[\\/]/.test(path);
  const bareFile = /^[\w.@+-]+\.[A-Za-z0-9]{1,10}$/.test(path) && !/^v?\d+(\.\d+)+$/i.test(path);
  if (!absolute && !hasDir && !bareFile) return undefined;
  // 盘符开头但盘符后面不是分隔符（C:12、C:foo）不是路径
  if (/^[A-Za-z]:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return undefined;

  return { path, ...(line ? { line } : {}) };
}
