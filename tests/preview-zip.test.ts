import AdmZip from "adm-zip"
import { describe, expect, it } from "vitest"
import { ZipFormatError, bytesReader, dosDateTime, isOleContainer, readZipListing } from "../src/shared/preview-zip"

// ── 最小 zip 构造器：只写清单关心的字段，内容用「存储」不压缩 ──────────────────

interface FileSpec {
  name: string | Uint8Array
  data?: string
  flags?: number
  dosDate?: number
  dosTime?: number
  /** 把大小写成 zip64 扩展字段里的这个值（头里写满 0xFFFFFFFF） */
  zip64Size?: bigint
}

interface BuildOptions {
  comment?: string | Uint8Array
  /** 压缩包前面多出来的字节（自解压包的外壳）；清单里的偏移仍是相对压缩包自己的开头 */
  prefix?: Uint8Array
  zip64Eocd?: boolean
}

const enc = new TextEncoder()
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function header(size: number, fill: (dv: DataView) => void): Uint8Array {
  const b = new Uint8Array(size)
  fill(new DataView(b.buffer))
  return b
}

function buildZip(files: FileSpec[], opts: BuildOptions = {}): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = typeof f.name === "string" ? enc.encode(f.name) : f.name
    const data = enc.encode(f.data ?? "")
    const local = concat([
      header(30, (dv) => {
        dv.setUint32(0, 0x04034b50, true)
        dv.setUint16(4, 20, true)
        dv.setUint16(6, f.flags ?? 0, true)
        dv.setUint16(26, name.length, true)
      }),
      name,
      data,
    ])
    const extra = f.zip64Size !== undefined
      ? header(20, (dv) => { dv.setUint16(0, 1, true); dv.setUint16(2, 16, true); dv.setBigUint64(4, f.zip64Size!, true); dv.setBigUint64(12, f.zip64Size!, true) })
      : new Uint8Array(0)
    central.push(concat([
      header(46, (dv) => {
        dv.setUint32(0, 0x02014b50, true)
        dv.setUint16(4, 20, true)
        dv.setUint16(6, 20, true)
        dv.setUint16(8, f.flags ?? 0, true)
        dv.setUint16(12, f.dosTime ?? 0, true)
        dv.setUint16(14, f.dosDate ?? 0, true)
        dv.setUint32(20, f.zip64Size !== undefined ? 0xffffffff : data.length, true)
        dv.setUint32(24, f.zip64Size !== undefined ? 0xffffffff : data.length, true)
        dv.setUint16(28, name.length, true)
        dv.setUint16(30, extra.length, true)
        dv.setUint32(42, offset, true)
      }),
      name,
      extra,
    ]))
    parts.push(local)
    offset += local.length
  }
  const cd = concat(central)
  const comment = typeof opts.comment === "string" ? enc.encode(opts.comment) : (opts.comment ?? new Uint8Array(0))
  const tail: Uint8Array[] = []
  if (opts.zip64Eocd) {
    const recordAt = offset + cd.length
    tail.push(
      header(56, (dv) => {
        dv.setUint32(0, 0x06064b50, true)
        dv.setBigUint64(4, 44n, true)
        dv.setBigUint64(24, BigInt(files.length), true)
        dv.setBigUint64(32, BigInt(files.length), true)
        dv.setBigUint64(40, BigInt(cd.length), true)
        dv.setBigUint64(48, BigInt(offset), true)
      }),
      header(20, (dv) => { dv.setUint32(0, 0x07064b50, true); dv.setBigUint64(8, BigInt(recordAt), true); dv.setUint32(16, 1, true) }),
    )
  }
  tail.push(header(22, (dv) => {
    dv.setUint32(0, 0x06054b50, true)
    dv.setUint16(8, opts.zip64Eocd ? 0xffff : files.length, true)
    dv.setUint16(10, opts.zip64Eocd ? 0xffff : files.length, true)
    dv.setUint32(12, opts.zip64Eocd ? 0xffffffff : cd.length, true)
    dv.setUint32(16, opts.zip64Eocd ? 0xffffffff : offset, true)
    dv.setUint16(20, comment.length, true)
  }), comment)
  return concat([opts.prefix ?? new Uint8Array(0), ...parts, cd, ...tail])
}

const list = (zip: Uint8Array, max?: number) => readZipListing(bytesReader(zip), zip.length, max)

describe("readZipListing", () => {
  it("列出真实压缩包（adm-zip 生成，带压缩和目录）的名字、大小、目录标记", async () => {
    const z = new AdmZip()
    z.addFile("src/", Buffer.alloc(0))
    z.addFile("src/a.txt", Buffer.from("hello ".repeat(500)))
    z.addFile("readme.md", Buffer.from("# hi"))
    const buf = z.toBuffer()
    const r = await list(new Uint8Array(buf))
    expect(r.total).toBe(3)
    expect(r.truncated).toBe(false)
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]))
    expect(byName["src/"].isDir).toBe(true)
    expect(byName["src/a.txt"]).toMatchObject({ isDir: false, size: 3000, encrypted: false })
    expect(byName["src/a.txt"].compressedSize).toBeLessThan(3000)
    expect(byName["readme.md"].size).toBe(4)
  })

  it("带 UTF-8 标志的名字按 UTF-8 解码", async () => {
    const r = await list(buildZip([{ name: "文档/报告.txt", flags: 0x0800 }]))
    expect(r.entries[0].name).toBe("文档/报告.txt")
  })

  it("没带 UTF-8 标志、又不是合法 UTF-8 的名字按 GBK 解（国内 Windows 打的包）", async () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]) // 中文.txt
    expect(new TextDecoder("gb18030").decode(gbk)).toBe("中文.txt")
    const r = await list(buildZip([{ name: gbk }]))
    expect(r.entries[0].name).toBe("中文.txt")
  })

  it("带了 UTF-8 标志就信标志：字节不合法时容错解码，不再去猜 GBK", async () => {
    const r = await list(buildZip([{ name: new Uint8Array([0xd6, 0xd0, 0x2e, 0x74]), flags: 0x0800 }]))
    expect(r.entries[0].name).toContain("\ufffd")
    expect(r.entries[0].name).not.toContain("中")
  })

  it("没带标志但本身是合法 UTF-8 的名字也按 UTF-8 解", async () => {
    const r = await list(buildZip([{ name: enc.encode("日本語.txt") }]))
    expect(r.entries[0].name).toBe("日本語.txt")
  })

  it("反斜杠路径统一成正斜杠，以斜杠结尾的是目录", async () => {
    const r = await list(buildZip([{ name: "a\\b\\c.txt" }, { name: "a\\b\\" }]))
    expect(r.entries.map((e) => [e.name, e.isDir])).toEqual([["a/b/c.txt", false], ["a/b/", true]])
  })

  it("读出修改时间；日期字段不合法就不给", async () => {
    const date = ((2024 - 1980) << 9) | (3 << 5) | 5
    const time = (10 << 11) | (20 << 5) | 15
    const r = await list(buildZip([{ name: "a", dosDate: date, dosTime: time }, { name: "b", dosDate: 0, dosTime: 0 }]))
    expect(r.entries[0].mtimeMs).toBe(new Date(2024, 2, 5, 10, 20, 30).getTime())
    expect(r.entries[1].mtimeMs).toBeUndefined()
  })

  it("标出加密条目", async () => {
    const r = await list(buildZip([{ name: "secret.txt", flags: 0x0001 }, { name: "open.txt" }]))
    expect(r.entries.map((e) => e.encrypted)).toEqual([true, false])
  })

  it("空压缩包", async () => {
    const r = await list(buildZip([]))
    expect(r).toEqual({ entries: [], total: 0, truncated: false })
  })

  it("压缩包注释里恰好有一串文件尾签名，不会被误认成文件尾", async () => {
    const fake = new Uint8Array(30)
    new DataView(fake.buffer).setUint32(0, 0x06054b50, true)
    const r = await list(buildZip([{ name: "a.txt" }, { name: "b.txt" }], { comment: fake }))
    expect(r.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"])
  })

  it("压缩包前面有一段多余数据（自解压包）：清单位置对不上时仍能读出", async () => {
    const r = await list(buildZip([{ name: "a.txt" }, { name: "b/c.txt" }], { prefix: new Uint8Array(500).fill(0x4d) }))
    expect(r.entries.map((e) => e.name)).toEqual(["a.txt", "b/c.txt"])
  })

  it("zip64：条目数写在 zip64 文件尾记录里，大文件的大小写在扩展字段里", async () => {
    const big = 6n * 1024n * 1024n * 1024n
    const r = await list(buildZip([{ name: "huge.bin", zip64Size: big }, { name: "small.txt", data: "abc" }], { zip64Eocd: true }))
    expect(r.total).toBe(2)
    expect(r.entries[0]).toMatchObject({ name: "huge.bin", size: Number(big), compressedSize: Number(big) })
    expect(r.entries[1].size).toBe(3)
  })

  it("超过 maxEntries 只列前面的，并标出被截断和总数", async () => {
    const zip = buildZip(["a", "b", "c", "d", "e"].map((name) => ({ name })))
    const r = await list(zip, 3)
    expect(r.entries.map((e) => e.name)).toEqual(["a", "b", "c"])
    expect(r.total).toBe(5)
    expect(r.truncated).toBe(true)
  })

  it("只按需读取：读文件尾（最多 64KB，容得下最长的注释）和清单，不读文件内容", async () => {
    const zip = buildZip([{ name: "a.txt", data: "x".repeat(1_000_000) }])
    const reads: [number, number][] = []
    await readZipListing(async (offset, length) => { reads.push([offset, length]); return zip.subarray(offset, offset + length) }, zip.length)
    const bytesRead = reads.reduce((n, [, len]) => n + len, 0)
    expect(bytesRead).toBeLessThan(70_000)
    expect(bytesRead).toBeLessThan(zip.length / 10)
  })

  it.each([
    ["比文件尾记录还短", new Uint8Array(10)],
    ["不是 zip", enc.encode("this is definitely not a zip archive, just text ".repeat(5))],
  ])("%s → 抛 ZipFormatError", async (_label, bytes) => {
    await expect(list(bytes)).rejects.toBeInstanceOf(ZipFormatError)
  })

  it("清单的签名被破坏 → 抛 ZipFormatError", async () => {
    const zip = buildZip([{ name: "a.txt" }])
    // 把中央目录第一条的签名改掉
    const at = zip.length - 22 - (46 + 5)
    zip[at] = 0
    await expect(list(zip)).rejects.toBeInstanceOf(ZipFormatError)
  })
})

describe("dosDateTime", () => {
  it("合法的日期时间换算成本地时间毫秒", () => {
    const date = ((2020 - 1980) << 9) | (12 << 5) | 31
    const time = (23 << 11) | (59 << 5) | 29
    expect(dosDateTime(date, time)).toBe(new Date(2020, 11, 31, 23, 59, 58).getTime())
  })
  it.each([
    ["月份为 0", 0 | 1],
    ["日为 0", (5 << 5) | 0],
  ])("%s → undefined", (_label, date) => {
    expect(dosDateTime(date, 0)).toBeUndefined()
  })
})

describe("bytesReader", () => {
  it("超出末尾只返回实际有的部分", async () => {
    const read = bytesReader(new Uint8Array([1, 2, 3, 4]))
    expect(Array.from(await read(2, 10))).toEqual([3, 4])
    expect((await read(10, 5)).length).toBe(0)
  })
})

describe("isOleContainer", () => {
  it("认旧版 Office / 加密 Office 文件的头，zip 和太短的数据不算", () => {
    expect(isOleContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe(true)
    expect(isOleContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
    expect(isOleContainer(new Uint8Array([0xd0, 0xcf, 0x11]))).toBe(false)
    expect(isOleContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe1]))).toBe(false)
    expect(isOleContainer(new Uint8Array(0))).toBe(false)
  })
})
