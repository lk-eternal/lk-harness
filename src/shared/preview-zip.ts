// ── 应用内预览：zip 文件清单（纯函数，不依赖 node:fs，读取方式由调用方注入）──────
//
// 只读「中央目录」：文件有多大都只读尾部那一小段，不解压任何内容，所以压缩炸弹碰不到这里。
// 读取函数由调用方给：主进程按文件偏移读，界面按内存里的字节读。

export interface ZipEntry {
  /** 条目路径，正斜杠分隔；目录以 / 结尾 */
  name: string;
  isDir: boolean;
  /** 解压后大小（字节） */
  size: number;
  compressedSize: number;
  /** 修改时间（毫秒）；压缩包里记的时间无效时为 undefined */
  mtimeMs?: number;
  encrypted: boolean;
}

export interface ZipListing {
  entries: ZipEntry[];
  /** 压缩包里一共有多少条；entries 被截断时比 entries.length 大 */
  total: number;
  truncated: boolean;
}

/** 读 [offset, offset+length) 的字节；到文件末尾不够长时返回实际读到的 */
export type ZipReader = (offset: number, length: number) => Promise<Uint8Array>;

/** 最多列出多少条：每条一行界面，再多既卡又没人看 */
export const ZIP_MAX_ENTRIES = 20_000;
/** 中央目录最多读这么多字节（2 万条、平均 100 字节的名字也只有 3MB 左右） */
const MAX_CENTRAL_DIRECTORY_BYTES = 12 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN = 22;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export class ZipFormatError extends Error {}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  const n = dv.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("压缩包里的数值超出范围");
  return Number(n);
}

interface Eocd {
  /** EOCD 记录在文件里的位置 */
  position: number;
  total: number;
  cdSize: number;
  cdOffset: number;
}

async function findEocd(read: ZipReader, fileSize: number): Promise<Eocd> {
  if (fileSize < EOCD_MIN) throw new ZipFormatError("不是有效的 zip 文件");
  const tailLength = Math.min(fileSize, MAX_COMMENT + EOCD_MIN + ZIP64_LOCATOR_SIZE);
  const tailStart = fileSize - tailLength;
  const tail = await read(tailStart, tailLength);
  const dv = view(tail);

  // 从后往前找签名。先要求「注释正好到文件末尾」，这样压缩包注释里恰好有一串签名字节时不会被误认；
  // 找不到再放宽（有些工具会在文件尾多写几个字节）
  const locate = (strict: boolean): number => {
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (dv.getUint32(i, true) !== EOCD_SIGNATURE) continue;
      const end = i + EOCD_MIN + dv.getUint16(i + 20, true);
      if (strict ? end === tail.length : end <= tail.length) return i;
    }
    return -1;
  };
  let at = locate(true);
  if (at < 0) at = locate(false);
  if (at < 0) throw new ZipFormatError("不是有效的 zip 文件（找不到文件尾）");

  const position = tailStart + at;
  let total = dv.getUint16(at + 10, true);
  let cdSize = dv.getUint32(at + 12, true);
  let cdOffset = dv.getUint32(at + 16, true);

  if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locatorAt = at - ZIP64_LOCATOR_SIZE;
    if (locatorAt >= 0 && dv.getUint32(locatorAt, true) === ZIP64_LOCATOR_SIGNATURE) {
      const recordOffset = u64(dv, locatorAt + 8);
      const record = await read(recordOffset, 56);
      const rv = view(record);
      if (record.length < 56 || rv.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw new ZipFormatError("zip64 文件尾已损坏");
      total = u64(rv, 32);
      cdSize = u64(rv, 40);
      cdOffset = u64(rv, 48);
    }
  }
  return { position, total, cdSize, cdOffset };
}

/** 名字：带 UTF-8 标志就按 UTF-8；没带的先试 UTF-8，不是合法 UTF-8 就按 GB18030（国内 Windows 打的包常这样） */
function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

/** DOS 日期时间 → 毫秒（本地时间）；字段不合法返回 undefined */
export function dosDateTime(date: number, time: number): number | undefined {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const second = (time & 0x1f) * 2;
  const minute = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** zip64 扩展字段（0x0001）：只有头里写满 0xFFFFFFFF 的那几项才会出现在里面，顺序固定：原始大小、压缩后大小 */
function zip64Sizes(extra: Uint8Array, wantSize: boolean, wantCompressed: boolean): { size?: number; compressed?: number } {
  const dv = view(extra);
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = dv.getUint16(at, true);
    const len = dv.getUint16(at + 2, true);
    if (id === 0x0001) {
      let p = at + 4;
      const end = Math.min(at + 4 + len, extra.length);
      const out: { size?: number; compressed?: number } = {};
      if (wantSize && p + 8 <= end) { out.size = u64(dv, p); p += 8; }
      if (wantCompressed && p + 8 <= end) out.compressed = u64(dv, p);
      return out;
    }
    at += 4 + len;
  }
  return {};
}

/** 解析中央目录里的条目，最多 maxEntries 条；数据在某一条中间断了就停在那条之前 */
function parseCentralDirectory(cd: Uint8Array, maxEntries: number): ZipEntry[] {
  const dv = view(cd);
  const entries: ZipEntry[] = [];
  let at = 0;
  while (entries.length < maxEntries) {
    if (at + 46 > cd.length) break;
    if (dv.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipFormatError("压缩包的文件清单已损坏");
    const flags = dv.getUint16(at + 8, true);
    const compressedRaw = dv.getUint32(at + 20, true);
    const sizeRaw = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > cd.length) break;

    const rawName = cd.subarray(at + 46, at + 46 + nameLen);
    const extra = cd.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    let size = sizeRaw;
    let compressedSize = compressedRaw;
    if (sizeRaw === U32_MAX || compressedRaw === U32_MAX) {
      const z = zip64Sizes(extra, sizeRaw === U32_MAX, compressedRaw === U32_MAX);
      if (z.size !== undefined) size = z.size;
      if (z.compressed !== undefined) compressedSize = z.compressed;
    }

    // 个别 Windows 工具会写反斜杠，统一成正斜杠
    const name = decodeName(rawName, (flags & 0x0800) !== 0).replace(/\\/g, "/");
    const mtimeMs = dosDateTime(dv.getUint16(at + 14, true), dv.getUint16(at + 12, true));
    entries.push({
      name,
      isDir: name.endsWith("/"),
      size,
      compressedSize,
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      encrypted: (flags & 0x0001) !== 0,
    });
    at = next;
  }
  return entries;
}

/** 读出压缩包里的文件清单。不是 zip 或文件清单损坏时抛 ZipFormatError */
export async function readZipListing(read: ZipReader, fileSize: number, maxEntries = ZIP_MAX_ENTRIES): Promise<ZipListing> {
  const eocd = await findEocd(read, fileSize);
  if (eocd.total === 0) return { entries: [], total: 0, truncated: false };

  // 中央目录的位置以文件头里写的偏移为准；对不上（压缩包前面被加了一段，如自解压包）就按「紧贴在文件尾记录之前」找
  const length = Math.min(eocd.cdSize, MAX_CENTRAL_DIRECTORY_BYTES);
  let cd = await read(eocd.cdOffset, length);
  if (cd.length < 4 || view(cd).getUint32(0, true) !== CENTRAL_SIGNATURE) {
    const fallback = eocd.position - eocd.cdSize;
    cd = fallback >= 0 ? await read(fallback, length) : new Uint8Array(0);
    if (cd.length < 4 || view(cd).getUint32(0, true) !== CENTRAL_SIGNATURE) throw new ZipFormatError("压缩包的文件清单已损坏");
  }

  const entries = parseCentralDirectory(cd, maxEntries);
  const total = Math.max(eocd.total, entries.length);
  return { entries, total, truncated: entries.length < total };
}

/** 内存里的字节当读取函数用（界面里已经有整个文件时） */
export function bytesReader(bytes: Uint8Array): ZipReader {
  return async (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.length));
}

/** 旧版 Office 文件、设了密码的 docx / xlsx 都是这个头（OLE 复合文档），不是 zip */
export function isOleContainer(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}