// ── 应用内预览：xlsx 单元格的数字格式（纯函数）──────────────────────────────────
//
// xlsx 里的数字、日期、百分比都存成一个裸数字，怎么显示由单元格样式里的「格式代码」决定
// （如 0.00、#,##0、0%、yyyy-mm-dd）。这里把「数字 + 格式代码」换成 Excel 里看到的文本。
// 覆盖日常用到的：常规、小数位、千分位、百分比、货币符号、科学计数、日期时间、经过时长。
// 分数、条件分区、本地化的月份星期名等不追求逐字一致，认不出的格式退回「常规」，宁可显示原数值也不显示错值。

/** 内置格式编号 → 格式代码（东亚区域那批日期格式简化成 ISO 风格） */
const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
  18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm",
  27: "yyyy-mm", 28: "mm-dd", 29: "mm-dd", 30: "yyyy-mm-dd", 31: "yyyy-mm-dd",
  32: "h:mm", 33: "h:mm:ss", 34: "h:mm", 35: "h:mm:ss", 36: "yyyy-mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
  50: "yyyy-mm", 51: "mm-dd", 52: "yyyy-mm", 53: "mm-dd", 54: "mm-dd",
  55: "h:mm", 56: "h:mm:ss", 57: "yyyy-mm", 58: "mm-dd",
};

/** 格式编号对应的代码：先看工作簿自定义的，再看内置的，都没有按常规 */
export function numFmtCode(id: number, custom: ReadonlyMap<number, string>): string {
  return custom.get(id) ?? BUILTIN[id] ?? "General";
}

// ── 词法 ──────────────────────────────────────────────────────────────────────

type Tok =
  | { k: "lit"; v: string }
  | { k: "y"; n: number }
  | { k: "mo"; n: number; elapsed: boolean; minute: boolean }
  | { k: "d"; n: number }
  | { k: "h"; n: number; elapsed: boolean }
  | { k: "s"; n: number; elapsed: boolean }
  | { k: "ampm"; short: boolean }
  | { k: "frac"; n: number }
  | { k: "ph"; ch: "0" | "#" | "?" }
  | { k: "dot" }
  | { k: "comma" }
  | { k: "pct" }
  | { k: "exp"; plus: boolean; digits: number };

/** 按分号切分节，引号、方括号、转义里的分号不算 */
export function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\\" && !inQuote) { cur += c + (code[i + 1] ?? ""); i++; continue; }
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === "[") inBracket = true;
    else if (!inQuote && c === "]") inBracket = false;
    if (c === ";" && !inQuote && !inBracket) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function runLength(s: string, at: number, chars: string): number {
  let n = 0;
  while (at + n < s.length && chars.includes(s[at + n])) n++;
  return n;
}

/** 一节格式代码里有没有日期时间记号（引号、方括号、转义里的不算） */
function hasDateTokens(section: string): boolean {
  for (let i = 0; i < section.length; i++) {
    const c = section[i];
    if (c === '"') { const end = section.indexOf('"', i + 1); i = end < 0 ? section.length : end; continue; }
    if (c === "\\" || c === "_" || c === "*") { i++; continue; }
    if (c === "[") {
      const end = section.indexOf("]", i + 1);
      const inner = end < 0 ? "" : section.slice(i + 1, end).toLowerCase();
      // [h] [mm] [ss] 是经过时长，算日期时间；[Red]、[$-409]、[>100] 不算
      if (/^(h+|m+|s+)$/.test(inner)) return true;
      i = end < 0 ? section.length : end;
      continue;
    }
    if (/[ymdhsYMDHS]/.test(c)) return true;
    if (/^(am\/pm|a\/p)/i.test(section.slice(i, i + 5))) return true;
  }
  return false;
}

function tokenize(section: string, dateMode: boolean): Tok[] {
  const toks: Tok[] = [];
  const lit = (v: string) => {
    const last = toks[toks.length - 1];
    if (last && last.k === "lit") last.v += v;
    else toks.push({ k: "lit", v });
  };
  for (let i = 0; i < section.length; i++) {
    const c = section[i];
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      lit(section.slice(i + 1, end < 0 ? section.length : end));
      i = end < 0 ? section.length : end;
      continue;
    }
    if (c === "\\") { lit(section[i + 1] ?? ""); i++; continue; }
    if (c === "_") { lit(" "); i++; continue; }
    if (c === "*") { i++; continue; }
    if (c === "[") {
      const end = section.indexOf("]", i + 1);
      const inner = end < 0 ? "" : section.slice(i + 1, end);
      const low = inner.toLowerCase();
      if (dateMode && /^h+$/.test(low)) toks.push({ k: "h", n: low.length, elapsed: true });
      else if (dateMode && /^m+$/.test(low)) toks.push({ k: "mo", n: low.length, elapsed: true, minute: true });
      else if (dateMode && /^s+$/.test(low)) toks.push({ k: "s", n: low.length, elapsed: true });
      else if (inner.startsWith("$")) lit(inner.slice(1).split("-")[0]); // [$¥-804] → ¥；[$-409] 只有区域，没有符号
      i = end < 0 ? section.length : end;
      continue;
    }
    if (dateMode) {
      if (/[yY]/.test(c)) { const n = runLength(section, i, "yY"); toks.push({ k: "y", n: n <= 2 ? 2 : 4 }); i += n - 1; continue; }
      if (/[mM]/.test(c)) { const n = runLength(section, i, "mM"); toks.push({ k: "mo", n, elapsed: false, minute: false }); i += n - 1; continue; }
      if (/[dD]/.test(c)) { const n = runLength(section, i, "dD"); toks.push({ k: "d", n }); i += n - 1; continue; }
      if (/[hH]/.test(c)) { const n = runLength(section, i, "hH"); toks.push({ k: "h", n, elapsed: false }); i += n - 1; continue; }
      if (/[sS]/.test(c)) { const n = runLength(section, i, "sS"); toks.push({ k: "s", n, elapsed: false }); i += n - 1; continue; }
      if (/^am\/pm/i.test(section.slice(i, i + 5))) { toks.push({ k: "ampm", short: false }); i += 4; continue; }
      if (/^a\/p/i.test(section.slice(i, i + 3))) { toks.push({ k: "ampm", short: true }); i += 2; continue; }
      const prev = toks[toks.length - 1];
      if (c === "." && prev && prev.k === "s" && section[i + 1] === "0") {
        const n = runLength(section, i + 1, "0");
        toks.push({ k: "frac", n: Math.min(n, 3) });
        i += n;
        continue;
      }
      lit(c);
      continue;
    }
    if (c === "0" || c === "#" || c === "?") { toks.push({ k: "ph", ch: c }); continue; }
    if (c === ".") { toks.push({ k: "dot" }); continue; }
    if (c === ",") { toks.push({ k: "comma" }); continue; }
    if (c === "%") { toks.push({ k: "pct" }); continue; }
    if ((c === "E" || c === "e") && (section[i + 1] === "+" || section[i + 1] === "-")) {
      const digits = runLength(section, i + 2, "0#?");
      toks.push({ k: "exp", plus: section[i + 1] === "+", digits });
      i += 1 + digits; // 跳过 E、符号和后面的位数占位符
      continue;
    }
    lit(c);
  }
  // m / mm 在 h 之后或 s 之前是「分」，其余是「月」
  const sig = toks.filter((t) => t.k !== "lit" && t.k !== "frac");
  toks.forEach((t) => {
    if (t.k !== "mo" || t.elapsed) return;
    const at = sig.indexOf(t);
    t.minute = (at > 0 && sig[at - 1].k === "h") || (at >= 0 && at < sig.length - 1 && sig[at + 1].k === "s");
  });
  return toks;
}

// ── 常规格式 ──────────────────────────────────────────────────────────────────

/** Excel「常规」：最多 15 位有效数字（去掉 0.1+0.2 这类浮点噪声），太大太小用科学计数 */
export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) {
    const [mantissa, exp] = n.toExponential(5).split("e");
    const sign = exp[0] === "-" ? "-" : "+";
    return `${mantissa.replace(/\.?0+$/, "")}E${sign}${exp.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(parseFloat(n.toPrecision(15)));
}

// ── 数字格式 ──────────────────────────────────────────────────────────────────

/** 四舍五入到 digits 位小数（按十进制位，避免 1.005.toFixed(2) 得到 1.00） */
function roundToFixed(value: number, digits: number): string {
  const s = String(value);
  if (s.includes("e")) return value.toFixed(digits);
  return Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`).toFixed(digits);
}

function group(intText: string): string {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderNumber(toks: Tok[], value: number, negativeSign: boolean): string {
  const pct = toks.filter((t) => t.k === "pct").length;
  const dotAt = toks.findIndex((t) => t.k === "dot");
  const phIndexes = toks.map((t, i) => (t.k === "ph" ? i : -1)).filter((i) => i >= 0);
  const lastPh = phIndexes[phIndexes.length - 1];
  const intPh = phIndexes.filter((i) => dotAt < 0 || i < dotAt);
  const decPh = phIndexes.filter((i) => dotAt >= 0 && i > dotAt);
  // 最后一个占位符之后的逗号：每个除以 1000
  let scale = 0;
  for (let i = lastPh + 1; i < toks.length; i++) {
    if (toks[i].k === "comma") scale++;
    else if (toks[i].k !== "lit") break;
  }
  // 整数占位符之间的逗号：千分位
  const thousands = intPh.length > 1 && toks.some((t, i) => t.k === "comma" && i > intPh[0] && i < intPh[intPh.length - 1]);

  let v = Math.abs(value) * 100 ** pct / 1000 ** scale;
  const exp = toks.find((t): t is Extract<Tok, { k: "exp" }> => t.k === "exp");
  let expText = "";
  if (exp) {
    let e = v === 0 ? 0 : Math.floor(Math.log10(v));
    let mant = v / 10 ** e;
    if (Number(roundToFixed(mant, decPh.length)) >= 10) { e += 1; mant = v / 10 ** e; }
    v = mant;
    const body = String(Math.abs(e)).padStart(exp.digits, "0");
    expText = `E${e < 0 ? "-" : exp.plus ? "+" : ""}${body}`;
  }

  const fixed = roundToFixed(v, decPh.length);
  const [intDigitsRaw, decDigits = ""] = fixed.split(".");
  const minInt = intPh.filter((i) => (toks[i] as Extract<Tok, { k: "ph" }>).ch === "0").length;
  // 整数部分为 0 且没有强制 0 的占位符（如 #.00）：不显示开头的 0
  const intDigits = intDigitsRaw === "0" && minInt === 0 ? "" : intDigitsRaw.padStart(minInt, "0");

  const litBetween = intPh.length > 1 && toks.slice(intPh[0], intPh[intPh.length - 1]).some((t) => t.k === "lit");
  const intOut = new Map<number, string>();
  if (intPh.length > 0) {
    if (!litBetween) {
      intOut.set(intPh[0], thousands ? group(intDigits) : intDigits);
      for (const i of intPh.slice(1)) intOut.set(i, "");
    } else {
      // 占位符之间夹着文字（000-0000、(###) ###-####）：数字从右往左填
      let rest = intDigits;
      for (let p = intPh.length - 1; p >= 0; p--) {
        const ch = (toks[intPh[p]] as Extract<Tok, { k: "ph" }>).ch;
        const digit = rest.slice(-1);
        rest = rest.slice(0, -1);
        intOut.set(intPh[p], digit || (ch === "0" ? "0" : ch === "?" ? " " : ""));
      }
      if (rest) intOut.set(intPh[0], rest + intOut.get(intPh[0]));
    }
  }
  const decOut = new Map<number, string>();
  decPh.forEach((i, n) => {
    const ch = (toks[i] as Extract<Tok, { k: "ph" }>).ch;
    const digit = decDigits[n] ?? "";
    // 小数末尾的 # 吞掉多余的 0
    const trailingZeros = ch !== "0" && /^0*$/.test(decDigits.slice(n));
    decOut.set(i, trailingZeros ? "" : digit);
  });

  // 小数部分全被吞掉时连小数点也不显示（0.## 显示 3，不是 3.）
  const showDot = decPh.some((p) => decOut.get(p) !== "");
  let out = "";
  toks.forEach((t, i) => {
    switch (t.k) {
      case "lit": out += t.v; break;
      case "ph": out += intOut.get(i) ?? decOut.get(i) ?? ""; break;
      case "dot": if (showDot) out += "."; break;
      case "pct": out += "%"; break;
      case "exp": out += expText; break;
      default: break; // comma 本身不输出（千分位、缩放已处理）
    }
  });
  return (negativeSign ? "-" : "") + out;
}

// ── 日期时间 ──────────────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface DateParts {
  y: number; m: number; d: number; weekday: number;
  /** 当天过了多少毫秒 */
  msOfDay: number;
  /** 从 0 点起一共多少毫秒（经过时长用） */
  totalMs: number;
}

const MAX_SERIAL = 2958465; // 9999-12-31

/** Excel 序列号 → 年月日时分秒。1900 系统里 1900-02-29 是 Excel 故意保留的错误，序列号 60 要显示成它 */
function dateParts(serial: number, date1904: boolean, granularityMs: number): DateParts | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > MAX_SERIAL) return undefined;
  let day = Math.floor(serial);
  // 按显示的精度四舍五入（只显示到秒就舍入到秒，显示一位小数秒就舍入到 100 毫秒），舍入后可能进位到第二天
  let ms = Math.round(Math.round((serial - day) * 86_400_000) / granularityMs) * granularityMs;
  if (ms >= 86_400_000) { day += 1; ms -= 86_400_000; }
  const totalMs = serial * 86_400_000;

  let y: number, m: number, d: number;
  if (date1904) {
    const dt = new Date(Date.UTC(1904, 0, 1) + day * 86_400_000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    return { y, m, d, weekday: dt.getUTCDay(), msOfDay: ms, totalMs };
  }
  if (day === 60) return { y: 1900, m: 2, d: 29, weekday: (day + 6) % 7, msOfDay: ms, totalMs };
  if (day < 60) {
    // 1899-12-31 当作序列号 0 往后数（1900-01-01 = 1）；0 号显示成 1900-01-00
    const dt = new Date(Date.UTC(1899, 11, 31) + day * 86_400_000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    if (day === 0) { y = 1900; m = 1; d = 0; }
    return { y, m, d, weekday: (day + 6) % 7, msOfDay: ms, totalMs };
  }
  const dt = new Date(Date.UTC(1899, 11, 30) + day * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.getUTCDay(), msOfDay: ms, totalMs };
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function renderDate(toks: Tok[], serial: number, date1904: boolean): string | undefined {
  const fracDigits = Math.max(0, ...toks.map((t) => (t.k === "frac" ? t.n : 0)));
  const granularityMs = fracDigits > 0 ? 10 ** (3 - fracDigits) : 1000;
  const p = dateParts(serial, date1904, granularityMs);
  if (!p) return undefined;
  const ampm = toks.find((t): t is Extract<Tok, { k: "ampm" }> => t.k === "ampm");
  const hours = Math.floor(p.msOfDay / 3_600_000);
  const minutes = Math.floor(p.msOfDay / 60_000) % 60;
  const seconds = Math.floor(p.msOfDay / 1000) % 60;
  const millis = p.msOfDay % 1000;
  const elapsedMs = Math.round(p.totalMs / granularityMs) * granularityMs;

  let out = "";
  for (const t of toks) {
    switch (t.k) {
      case "lit": out += t.v; break;
      case "y": out += t.n === 2 ? pad(p.y % 100, 2) : pad(p.y, 4); break;
      case "mo":
        if (t.elapsed) out += pad(Math.floor(elapsedMs / 60_000), t.n);
        else if (t.minute) out += pad(minutes, t.n >= 2 ? 2 : 1);
        else if (t.n <= 2) out += pad(p.m, t.n);
        else if (t.n === 3) out += MONTHS[p.m - 1].slice(0, 3);
        else if (t.n === 4) out += MONTHS[p.m - 1];
        else out += MONTHS[p.m - 1][0];
        break;
      case "d":
        if (t.n <= 2) out += pad(p.d, t.n);
        else if (t.n === 3) out += DAYS[p.weekday].slice(0, 3);
        else out += DAYS[p.weekday];
        break;
      case "h": {
        const h = t.elapsed ? Math.floor(elapsedMs / 3_600_000) : ampm ? (hours % 12 === 0 ? 12 : hours % 12) : hours;
        out += pad(h, t.n >= 2 ? 2 : 1);
        break;
      }
      case "s":
        out += t.elapsed ? pad(Math.floor(elapsedMs / 1000), t.n) : pad(seconds, t.n >= 2 ? 2 : 1);
        break;
      case "ampm": out += hours < 12 ? (t.short ? "A" : "AM") : (t.short ? "P" : "PM"); break;
      case "frac": out += `.${pad(millis, 3).slice(0, t.n)}`; break;
      default: break;
    }
  }
  return out;
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export interface FormatOptions {
  date1904?: boolean;
}

/** 数字 + 格式代码 → 显示文本。认不出的格式退回「常规」 */
export function formatNumber(value: number, code: string, opts: FormatOptions = {}): string {
  const trimmed = code.trim();
  if (!Number.isFinite(value) || trimmed === "" || /^general$/i.test(trimmed) || trimmed === "@") return formatGeneral(value);

  const sections = splitSections(trimmed);
  // 一节：所有数；两节：正数和零 / 负数；三节：正数 / 负数 / 零
  const negative = value < 0;
  let index = 0;
  if (sections.length >= 2 && negative) index = 1;
  else if (sections.length >= 3 && value === 0) index = 2;
  const section = sections[index];
  const showMinus = negative && index === 0;

  if (/^general$/i.test(section.trim())) return formatGeneral(value);
  if (hasDateTokens(section)) {
    const text = renderDate(tokenize(section, true), value, opts.date1904 === true);
    return text === undefined ? formatGeneral(value) : text;
  }
  // 分数（# ?/?）这里不做，显示原数值
  if (/[#0?]\s*\/\s*[#0?\d]/.test(section.replace(/"[^"]*"/g, ""))) return formatGeneral(value);
  const toks = tokenize(section, false);
  if (!toks.some((t) => t.k === "ph")) {
    // 只有文字的格式（如 "已完成"）：照原样显示那段文字
    return toks.map((t) => (t.k === "lit" ? t.v : "")).join("");
  }
  return renderNumber(toks, value, showMinus);
}
