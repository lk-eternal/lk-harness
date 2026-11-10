// ── HTTP Range 头解析（预览协议给音视频/PDF 分段返回内容用）──────────────────

export interface ByteRange {
  /** 起止都含 */
  start: number;
  end: number;
}

/**
 * 解析 `Range: bytes=...`。
 * - 没有头、不是 bytes 单位、多段范围：返回 null，调用方整份返回（200）
 * - 范围落在文件之外：返回 "unsatisfiable"，调用方回 416
 * - 否则返回规整后的起止（end 超出文件末尾时收到末尾）
 *
 * 音视频拖动进度靠这个：服务端不认 Range、总是整份回 200，浏览器就不让拖动。
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, from, to] = m;
  if (from === "" && to === "") return null;
  if (size <= 0) return "unsatisfiable";

  if (from === "") {
    // 后缀范围：最后 N 个字节
    const n = Number(to);
    if (n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
