// ── 应用内预览：读 xlsx 工作簿（只读，转成能直接画成表格的数据）──────────────────
//
// xlsx 是一个 zip，里面是 SpreadsheetML 的 xml：工作簿 → 工作表、共享字符串、样式（数字格式）。
// 这里只取「显示出来的样子」：单元格文本（按数字格式换算好）、合并区域、列宽。公式只看缓存的结果，不计算。
// 工作表按需解析：打开工作簿只读目录，切到哪个标签才解析哪个，几十个 sheet 的大文件也不会一次卡住。
// XML 解析器由调用方给（界面用 DOMParser，测试用 xmldom），本文件不依赖浏览器环境。

import JSZip from "jszip";
import { bytesReader, isOleContainer, readZipListing } from "./preview-zip.js";
import { formatNumber, numFmtCode } from "./preview-xlsx-format.js";

/** 一个工作表最多显示的行数 / 列数：再多既卡又没人在应用里看 */
export const XLSX_MAX_ROWS = 5000;
export const XLSX_MAX_COLS = 100;

/** 单个 xml 部件解压后的上限；超过说明数据量大到解析会拖垮界面 */
const MAX_PART_BYTES = 60 * 1024 * 1024;

const NS_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export class XlsxFormatError extends Error {}

export interface XlsxCell {
  text: string;
  /** 数字、日期这类，靠右显示 */
  right?: boolean;
  /** 文件里没存这个公式的计算结果，text 是公式本身（以 = 开头） */
  formula?: boolean;
}

/** 合并区域；行列都从 0 开始，左上角那格有内容，其余被盖住 */
export interface XlsxMerge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface XlsxSheetData {
  /** 按行排；行里按列下标存，没内容的格子是空洞 */
  rows: (XlsxCell | undefined)[][];
  rowCount: number;
  columns: number;
  merges: XlsxMerge[];
  /** 列宽（像素），没设置的列是 undefined */
  colWidths: (number | undefined)[];
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface XlsxSheetInfo {
  name: string;
  /** 在 Excel 里被隐藏的工作表 */
  hidden: boolean;
}

export interface XlsxWorkbook {
  sheets: XlsxSheetInfo[];
  readSheet(index: number): Promise<XlsxSheetData>;
}

export type ParseXml = (text: string) => Document;

/** 浏览器里的默认解析器 */
export function domParseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new XlsxFormatError("文件内容损坏，无法解析");
  return doc;
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function children(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === local) out.push(n as Element);
  }
  return out;
}

function child(el: Element, local: string): Element | undefined {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === local) return n as Element;
  }
  return undefined;
}

/** A → 0，Z → 25，AA → 26 */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 → A，25 → Z，26 → AA（表头上的列名） */
export function columnLabel(index: number): string {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}

function parseCellRef(ref: string): { row: number; col: number } | undefined {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(ref);
  if (!m) return undefined;
  return { row: Number(m[2]) - 1, col: colIndex(m[1]) };
}

/** 一段富文本（<si> 或 <is>）里的纯文本：把 <t> 接起来，跳过拼音注释 <rPh> */
function richText(el: Element): string {
  let out = "";
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    if (e.localName === "t") out += e.textContent ?? "";
    else if (e.localName === "r") out += child(e, "t")?.textContent ?? "";
  }
  return out;
}

/** 相对 base 目录解析 Target：/xl/x.xml 是绝对路径，../ 向上一级 */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function truthy(v: string | null): boolean {
  return v === "1" || v === "true";
}

/** 列宽（字符数）换成像素：Excel 默认字体下一个字符约 7 像素，再加单元格内边距 */
function widthToPx(chars: number): number {
  return Math.min(480, Math.max(36, Math.round(chars * 7 + 5)));
}

// ── 打开工作簿 ────────────────────────────────────────────────────────────────

export async function openXlsx(bytes: Uint8Array, parseXml: ParseXml = domParseXml): Promise<XlsxWorkbook> {
  if (isOleContainer(bytes)) throw new XlsxFormatError("这个文件设了打开密码，或者是旧版 Excel 格式，无法在应用内预览");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new XlsxFormatError("不是有效的 xlsx 文件");
  }

  // 各部件解压后多大：从中央目录读，不用先解压就能拦下超大的部件
  const sizes = new Map<string, number>();
  try {
    for (const e of (await readZipListing(bytesReader(bytes), bytes.length)).entries) sizes.set(e.name, e.size);
  } catch { /* 清单读不出来就不做大小检查，JSZip 已经能打开了 */ }

  const readPart = async (path: string): Promise<Document | undefined> => {
    const file = zip.file(path);
    if (!file) return undefined;
    if ((sizes.get(path) ?? 0) > MAX_PART_BYTES) throw new XlsxFormatError("这个工作表的数据量太大，无法在应用内预览");
    const text = (await file.async("string")).replace(/^\uFEFF/, "");
    return parseXml(text);
  };

  const workbookDoc = await readPart("xl/workbook.xml");
  if (!workbookDoc) throw new XlsxFormatError("不是有效的 xlsx 文件（缺少工作簿）");
  const date1904 = truthy(workbookDoc.getElementsByTagNameNS("*", "workbookPr")[0]?.getAttribute("date1904") ?? null);

  const relDoc = await readPart("xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  if (relDoc) {
    for (const rel of Array.from(relDoc.getElementsByTagNameNS("*", "Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) targets.set(id, resolveTarget("xl", target));
    }
  }

  const sheets: (XlsxSheetInfo & { path: string })[] = [];
  Array.from(workbookDoc.getElementsByTagNameNS("*", "sheet")).forEach((el, i) => {
    // 不同解析器对「没有这个属性」返回 null 或空串，所以用 || 兜底
    const rid = el.getAttributeNS(NS_RELATIONSHIPS, "id") || el.getAttribute("r:id");
    const state = el.getAttribute("state");
    sheets.push({
      name: el.getAttribute("name") ?? `Sheet${i + 1}`,
      hidden: state === "hidden" || state === "veryHidden",
      path: (rid ? targets.get(rid) : undefined) ?? `xl/worksheets/sheet${i + 1}.xml`,
    });
  });
  if (sheets.length === 0) throw new XlsxFormatError("这个工作簿里没有工作表");

  // 共享字符串、样式：用到才读，读一次
  let sharedStrings: Promise<string[]> | undefined;
  const loadSharedStrings = (): Promise<string[]> => (sharedStrings ??= (async () => {
    const doc = await readPart("xl/sharedStrings.xml");
    if (!doc) return [];
    return Array.from(doc.getElementsByTagNameNS("*", "si")).map(richText);
  })());

  let styles: Promise<{ xfFormats: string[] }> | undefined;
  const loadStyles = (): Promise<{ xfFormats: string[] }> => (styles ??= (async () => {
    const doc = await readPart("xl/styles.xml");
    if (!doc) return { xfFormats: [] };
    const custom = new Map<number, string>();
    for (const f of Array.from(doc.getElementsByTagNameNS("*", "numFmt"))) {
      const id = Number(f.getAttribute("numFmtId"));
      const code = f.getAttribute("formatCode");
      if (Number.isFinite(id) && code !== null) custom.set(id, code);
    }
    const cellXfs = doc.getElementsByTagNameNS("*", "cellXfs")[0];
    const xfFormats = cellXfs ? children(cellXfs, "xf").map((xf) => numFmtCode(Number(xf.getAttribute("numFmtId") ?? 0), custom)) : [];
    return { xfFormats };
  })());

  return {
    sheets: sheets.map(({ name, hidden }) => ({ name, hidden })),
    async readSheet(index: number): Promise<XlsxSheetData> {
      const sheet = sheets[index];
      if (!sheet) throw new XlsxFormatError("没有这个工作表");
      const doc = await readPart(sheet.path);
      if (!doc) throw new XlsxFormatError(`找不到工作表「${sheet.name}」的内容`);
      const [strings, { xfFormats }] = await Promise.all([loadSharedStrings(), loadStyles()]);
      return parseSheet(doc, strings, xfFormats, date1904);
    },
  };
}

// ── 解析一个工作表 ────────────────────────────────────────────────────────────

function cellOf(c: Element, strings: string[], xfFormats: string[], date1904: boolean): XlsxCell | undefined {
  const type = c.getAttribute("t");
  const raw = child(c, "v")?.textContent ?? "";

  // 公式没有缓存结果（脚本生成的 xlsx 没经过 Excel 重算就是这样）：这里不计算，显示公式本身，比一片空白有用
  if (raw === "" && type !== "inlineStr") {
    const formula = child(c, "f")?.textContent?.trim();
    return formula ? { text: `=${formula}`, formula: true } : undefined;
  }

  if (type === "inlineStr") {
    const is = child(c, "is");
    const text = is ? richText(is) : "";
    return text ? { text } : undefined;
  }
  if (type === "s") {
    const text = strings[Number(raw)] ?? "";
    return text ? { text } : undefined;
  }
  if (type === "b") return raw ? { text: raw === "1" ? "TRUE" : "FALSE" } : undefined;
  if (type === "str" || type === "e" || type === "d") return raw ? { text: raw } : undefined;

  // 数字（t 缺省或 "n"）：按单元格样式里的数字格式换算
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return { text: raw };
  const code = xfFormats[Number(c.getAttribute("s") ?? 0)] ?? "General";
  return { text: formatNumber(value, code, { date1904 }), right: true };
}

function parseSheet(doc: Document, strings: string[], xfFormats: string[], date1904: boolean): XlsxSheetData {
  const rows: (XlsxCell | undefined)[][] = [];
  let maxRow = -1;
  let maxCol = -1;
  let truncatedRows = false;
  let truncatedCols = false;

  const sheetData = doc.getElementsByTagNameNS("*", "sheetData")[0];
  let rowAt = -1;
  for (const rowEl of sheetData ? children(sheetData, "row") : []) {
    const r = rowEl.getAttribute("r");
    rowAt = r ? Number(r) - 1 : rowAt + 1;
    if (!Number.isInteger(rowAt) || rowAt < 0) continue;
    if (rowAt >= XLSX_MAX_ROWS) { truncatedRows = true; break; }

    let colAt = -1;
    for (const c of children(rowEl, "c")) {
      const ref = c.getAttribute("r");
      const parsed = ref ? parseCellRef(ref) : undefined;
      colAt = parsed ? parsed.col : colAt + 1;
      if (colAt < 0) continue;
      if (colAt >= XLSX_MAX_COLS) { truncatedCols = true; continue; }
      const cell = cellOf(c, strings, xfFormats, date1904);
      if (!cell) continue;
      (rows[rowAt] ??= [])[colAt] = cell;
      if (rowAt > maxRow) maxRow = rowAt;
      if (colAt > maxCol) maxCol = colAt;
    }
  }

  // 合并区域：只留落在显示范围里的；大小按显示范围截断
  const merges: XlsxMerge[] = [];
  for (const m of Array.from(doc.getElementsByTagNameNS("*", "mergeCell"))) {
    const [a, b] = (m.getAttribute("ref") ?? "").split(":");
    const from = a ? parseCellRef(a) : undefined;
    const to = b ? parseCellRef(b) : undefined;
    if (!from || !to || from.row >= XLSX_MAX_ROWS || from.col >= XLSX_MAX_COLS) continue;
    const rowEnd = Math.min(to.row, XLSX_MAX_ROWS - 1);
    const colEnd = Math.min(to.col, XLSX_MAX_COLS - 1);
    if (rowEnd < from.row || colEnd < from.col || (rowEnd === from.row && colEnd === from.col)) continue;
    merges.push({ row: from.row, col: from.col, rows: rowEnd - from.row + 1, cols: colEnd - from.col + 1 });
    // 合并出来的空白区域也要画出来，所以行列数要把它算进去
    if (rowEnd > maxRow) maxRow = rowEnd;
    if (colEnd > maxCol) maxCol = colEnd;
  }

  const colWidths: (number | undefined)[] = [];
  const colsEl = doc.getElementsByTagNameNS("*", "cols")[0];
  for (const col of colsEl ? children(colsEl, "col") : []) {
    const min = Number(col.getAttribute("min"));
    const max = Number(col.getAttribute("max"));
    const width = Number(col.getAttribute("width"));
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(width) || width <= 0) continue;
    for (let i = Math.max(1, min); i <= Math.min(max, maxCol + 1); i++) colWidths[i - 1] = widthToPx(width);
  }

  const rowCount = maxRow + 1;
  for (let i = 0; i < rowCount; i++) rows[i] ??= [];
  return { rows, rowCount, columns: maxCol + 1, merges, colWidths, truncatedRows, truncatedCols };
}
