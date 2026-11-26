import * as fs from "node:fs";

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 从图片文件头读宽高。认 PNG / JPEG / GIF / WebP，其他格式或文件残缺返回 undefined */
export function parseImageSize(buf: Buffer): ImageSize | undefined {
  const size = parsePng(buf) ?? parseGif(buf) ?? parseJpeg(buf) ?? parseWebp(buf);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

/** 读文件并解析宽高；读不出文件、认不出格式都当作「拿不到尺寸」返回 undefined */
export async function readImageFileSize(filePath: string): Promise<ImageSize | undefined> {
  try {
    return parseImageSize(await fs.promises.readFile(filePath));
  } catch {
    return undefined;
  }
}

function parsePng(buf: Buffer): ImageSize | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGif(buf: Buffer): ImageSize | undefined {
  if (buf.length < 10) return undefined;
  const magic = buf.toString("ascii", 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function parseJpeg(buf: Buffer): ImageSize | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // EOI / SOS：走到这里还没见到帧头，后面是图像数据，不会再有了
    if (marker === 0xd9 || marker === 0xda) return undefined;
    // 没有长度字段的标记：TEM、RSTn
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (isJpegStartOfFrame(marker)) {
      if (offset + 9 > buf.length) return undefined;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return undefined;
}

function parseWebp(buf: Buffer): ImageSize | undefined {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // 有损：3 字节帧标记 + 3 字节起始码之后，是各 14 位的宽高
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // 无损：1 字节签名之后，各 14 位的（宽-1）（高-1）
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // 扩展格式：画布宽高各 24 位，存的是（值-1）
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return undefined;
}
