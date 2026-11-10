// ── 应用内预览：文本解码、CSV 解析、高亮结果分行（纯函数）────────────────────

export type PreviewEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export interface DecodedText {
  text: string;
  encoding: PreviewEncoding;
  /** 看起来是二进制（无 BOM 且开头有 NUL）：text 为空，不要显示 */
  binary: boolean;
}

const SNIFF_BYTES = 8000;

/**
 * 把文件内容解成文本：先认 BOM，再试 UTF-8，不是合法 UTF-8 就按 GB18030（国内 Windows 上的 txt / csv 常是 GBK）。
 * truncated=true 表示 bytes 只是文件开头一段，末尾可能切在一个多字节字符中间，不能因此判成非 UTF-8。
 */
export function decodePreviewText(bytes: Uint8Array, truncated = false): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3), { stream: truncated }), encoding: "utf-8", binary: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2), { stream: truncated }), encoding: "utf-16le", binary: false };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2), { stream: truncated }), encoding: "utf-16be", binary: false };
  }

  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return { text: "", encoding: "utf-8", binary: true };

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }), encoding: "utf-8", binary: false };
  } catch {
    return { text: new TextDecoder("gb18030").decode(bytes, { stream: truncated }), encoding: "gb18030", binary: false };
  }
}

/** 猜分隔符：tsv 一定是 tab；其它在首行里数逗号、分号、tab，哪个多用哪个，都没有就是逗号 */
export function detectDelimiter(text: string, ext: string): string {
  if (ext === "tsv") return "\t";
  const firstLine = text.slice(0, text.search(/\r|\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const candidates: [string, number][] = [[",", count(",")], [";", count(";")], ["\t", count("\t")]];
  const best = candidates.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ",";
}

/**
 * RFC 4180：双引号包裹的字段里可以有分隔符、换行，两个引号表示一个引号；换行认 CRLF / LF。
 * maxRows 到了就停（预览不需要整张表），返回是否被截断。
 */
export function parseCsv(text: string, delimiter = ",", maxRows = Infinity): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;

  const endRow = (): boolean => {
    row.push(field);
    field = "";
    // 空行（包括文件末尾多出来的那个）不算一行
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };

  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (endRow()) return { rows, truncated: i < n };
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, truncated: false };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 把 CRLF / CR 统一成 LF，按行切开 */
export function splitTextLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * 把 highlight.js 输出的 HTML 按行切开。多行的注释、字符串会让一个 <span> 跨行，
 * 切行时在行尾补上闭合标签、下一行开头重开同样的标签，每一行单独拿出来都是合法片段。
 * highlight.js 只会产出 <span ...> 和 </span>，换行只出现在文本里。
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "") continue;
    if (part === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else if (part === "</span>") {
      open.pop();
      current += part;
    } else if (part.startsWith("<span")) {
      open.push(part);
      current += part;
    } else {
      current += part;
    }
  }
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}
