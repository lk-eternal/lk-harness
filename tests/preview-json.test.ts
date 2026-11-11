import { describe, expect, it } from "vitest"
import {
  findJsonError, formatJson, formatJsonFor, formatJsonLines, jsonFormatKind, lineColumnAt, reindentJson, shouldDefaultToFormatted,
} from "../src/shared/preview-json"

/** 去掉字符串之外的所有空白：格式化只能动空白，不能动任何 token */
const minify = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (m) => (m[0] === '"' ? m : ""))

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STRINGS = ["", "a", "中文", "with \"quote\"", "back\\slash", "line\nbreak", "tab\t", "{[,:]}", "\u0001", "😀", "/*", "//x", "\\u0041"]
const NUMBERS = ["0", "-0", "1", "-12", "3.14", "-0.5e10", "1E+5", "2e-3", "12345678901234567890", "1e400", "0.1000"]

/** 生成一段写法各异（缩进、空白随机）的合法 JSON 文本 */
function randomJsonText(rand: () => number, depth = 0): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
  const ws = (): string => pick(["", "", " ", "\n", "\r\n  ", "\t"])
  const kind = depth >= 4 ? Math.floor(rand() * 4) : Math.floor(rand() * 6)
  if (kind === 0) return pick(NUMBERS)
  if (kind === 1) return JSON.stringify(pick(STRINGS))
  if (kind === 2) return pick(["true", "false", "null"])
  if (kind === 3) return pick(NUMBERS)
  if (kind === 4) {
    const n = Math.floor(rand() * 4)
    const items = Array.from({ length: n }, () => ws() + randomJsonText(rand, depth + 1) + ws())
    return "[" + ws() + items.join(",") + ws() + "]"
  }
  const n = Math.floor(rand() * 4)
  const items = Array.from({ length: n }, () => ws() + JSON.stringify(pick(STRINGS)) + ws() + ":" + ws() + randomJsonText(rand, depth + 1) + ws())
  return "{" + ws() + items.join(",") + ws() + "}"
}

describe("reindentJson", () => {
  it("每层两个空格，一个值一行；空对象 / 空数组保持原样", () => {
    expect(reindentJson('{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[]}')).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": [',
        "    1,",
        "    2,",
        "    {",
        '      "c": null',
        "    }",
        "  ],",
        '  "d": {},',
        '  "e": []',
        "}",
      ].join("\n"),
    )
  })

  it("已经排好版的也能处理；空白里的换行、tab、CRLF 都被收掉", () => {
    expect(reindentJson('{\r\n\t"a" :\t1 ,\r\n\t"b":  [ ]\r\n}')).toBe('{\n  "a": 1,\n  "b": []\n}')
  })

  it("顶层是单个值也行", () => {
    expect(reindentJson("  42 ")).toBe("42")
    expect(reindentJson('"x"')).toBe('"x"')
    expect(reindentJson("[]")).toBe("[]")
    expect(reindentJson("null")).toBe("null")
  })

  it("字符串原样：里面的括号、逗号、冒号、转义引号、反斜杠都不动", () => {
    const s = '{"k":"a,b:{c}[d]\\"e\\\\","\\"q\\"":"\\u0041\\n"}'
    const out = reindentJson(s)
    expect(out).toBe('{\n  "k": "a,b:{c}[d]\\"e\\\\",\n  "\\"q\\"": "\\u0041\\n"\n}')
  })

  it("数字原样：大整数不丢精度，指数、-0、小数末尾的 0 都保留", () => {
    const out = reindentJson("[12345678901234567890,1E+5,-0,0.1000,1e400]")
    expect(out).toBe("[\n  12345678901234567890,\n  1E+5,\n  -0,\n  0.1000,\n  1e400\n]")
  })

  it("键的顺序和重复的键都保留（JSON.parse 再 stringify 会把它们改掉）", () => {
    const out = reindentJson('{"b":1,"2":2,"1":3,"b":4}')
    expect(out).toBe('{\n  "b": 1,\n  "2": 2,\n  "1": 3,\n  "b": 4\n}')
  })

  it("万一传来不合法的文本（没结束的字符串、转义错位）也只是输出点什么，不会死循环", () => {
    expect(typeof reindentJson('{"a": "abc')).toBe("string")
    expect(typeof reindentJson('"abc\\')).toBe("string")
    expect(typeof reindentJson('["a\\"')).toBe("string")
    expect(typeof reindentJson("}{][,:")).toBe("string")
  })

  it("嵌套很深也不会爆栈", () => {
    const depth = 3000
    const out = reindentJson("[".repeat(depth) + "]".repeat(depth))
    expect(out.length).toBeGreaterThan(depth)
    expect(minify(out)).toBe("[".repeat(depth) + "]".repeat(depth))
  })

  it("随机 JSON：只改空白（去掉空白后和原文一致）、语义不变、再格式化一次结果不变", () => {
    const rand = mulberry32(20261111)
    for (let i = 0; i < 400; i++) {
      const text = randomJsonText(rand)
      expect(() => JSON.parse(text), text).not.toThrow()
      const out = reindentJson(text)
      expect(minify(out), text).toBe(minify(text))
      expect(JSON.parse(out), text).toEqual(JSON.parse(text))
      expect(reindentJson(out), text).toBe(out)
    }
  })
})

describe("findJsonError：和 JSON.parse 对拍", () => {
  const accepts = (text: string): boolean => {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }

  it("随机合法 JSON 再随机改坏一个字符：合法与否和 JSON.parse 一致", () => {
    const rand = mulberry32(7)
    const noise = ['"', "'", "{", "}", "[", "]", ",", ":", "\\", " ", "\n", "/", "a", "e", "0", "-", ".", "+", "\u0000", "#"]
    let rejected = 0
    for (let i = 0; i < 3000; i++) {
      const text = randomJsonText(rand)
      expect(findJsonError(text), `合法的却报错：${text}`).toBeUndefined()
      const at = Math.floor(rand() * (text.length + 1))
      const how = Math.floor(rand() * 3)
      const bad =
        how === 0 ? text.slice(0, at) + text.slice(at + 1)
        : how === 1 ? text.slice(0, at) + noise[Math.floor(rand() * noise.length)] + text.slice(at)
        : text.slice(0, at) + noise[Math.floor(rand() * noise.length)] + text.slice(at + 1)
      const expected = accepts(bad)
      const found = findJsonError(bad)
      expect(found === undefined, `JSON.parse ${expected ? "接受" : "拒绝"}：${JSON.stringify(bad)}，找错结果：${JSON.stringify(found)}`).toBe(expected)
      if (!expected) rejected++
    }
    // 改坏的样本里要真的有足够多不合法的，不然这条测试什么都没测
    expect(rejected).toBeGreaterThan(1000)
  })

  it("逐条的边界写法", () => {
    const cases: [string, boolean][] = [
      ["", false], [" ", false], ["{}", true], ["[]", true], ["01", false], ["1.", false], [".5", false], ["-", false], ["+1", false],
      ["1e", false], ["1e+", false], ["0e0", true], ["-0.0e-0", true], ["tru", false], ["truee", false], ["nul", false], ["NaN", false],
      ["Infinity", false], ["'a'", false], ['"a', false], ['"a\nb"', false], ['"a\tb"', false], ['"\\x41"', false], ['"\\u00G1"', false],
      ['"\\u00"', false], ['"\\u0041"', true], ['"\\/"', true], ["[1,]", false], ["[,1]", false], ["[1 2]", false], ['{"a":1,}', false],
      ['{"a" 1}', false], ["{a:1}", false], ['{"a":}', false], ['{"a":1 "b":2}', false], ["{}{}", false], ["[] x", false], ["[[[]]]", true],
      ["{\"a\":{\"b\":[{}]}}", true], ["// c\n{}", false], ["{ /* c */ }", false], ["\ufeff{}", false], ["{}\n", true], ["\r\n[ 1 ]\r\n", true],
    ]
    for (const [text, ok] of cases) {
      expect(accepts(text), `前提：JSON.parse 对 ${JSON.stringify(text)}`).toBe(ok)
      expect(findJsonError(text) === undefined, JSON.stringify(text)).toBe(ok)
    }
  })

  it("错误位置和说法", () => {
    const at = (text: string) => {
      const e = findJsonError(text)!
      return { ...lineColumnAt(text, e.index), message: e.message }
    }
    expect(at('{"a":1,}')).toMatchObject({ line: 1, column: 8 })
    expect(at('{"a":1,}').message).toContain("尾逗号")
    expect(at('[\n  1,\n  2,\n]')).toMatchObject({ line: 4, column: 1 })
    expect(at('{"a" 1}')).toMatchObject({ line: 1, column: 6 })
    expect(at('{"a" 1}').message).toContain("冒号")
    expect(at('{a:1}').message).toContain("双引号")
    expect(at("{'a':1}").message).toContain("单引号")
    expect(at("['a']").message).toContain("单引号")
    expect(at('{"a":1}\n}')).toMatchObject({ line: 2, column: 1 })
    expect(at('{"a":1}\n}').message).toContain("多余")
    expect(at('{"a":"x\ny"}').message).toContain("换行")
    expect(at('{"a":"x\ny"}')).toMatchObject({ line: 1, column: 8 })
    expect(at('"abc').message).toContain("没有结束")
    expect(at('[1,2').message).toContain("中途结束")
    expect(at("").message).toContain("空")
    expect(at("   \n ").message).toContain("空")
    expect(at('"\\q"').message).toContain("转义")
    expect(at('"\\u12"').message).toContain("十六进制")
  })

  it("带注释的 JSON（tsconfig.json 这类）：明确说是含有注释，位置指到注释", () => {
    const text = '{\n  // 编译选项\n  "a": 1\n}'
    const e = findJsonError(text)!
    expect(e.message).toContain("注释")
    expect(lineColumnAt(text, e.index)).toEqual({ line: 2, column: 3 })
    expect(findJsonError('{"a": 1 /* x */}')!.message).toContain("注释")
  })

  it("字符串里出现 // 不算注释", () => {
    expect(findJsonError('{"url":"http://a.com/*x*/"}')).toBeUndefined()
  })
})

describe("lineColumnAt", () => {
  it("从 1 开始；行首列号是 1；CRLF 的 \\r 算在上一行末尾", () => {
    expect(lineColumnAt("abc", 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumnAt("abc", 2)).toEqual({ line: 1, column: 3 })
    expect(lineColumnAt("ab\ncd", 3)).toEqual({ line: 2, column: 1 })
    expect(lineColumnAt("ab\r\ncd", 4)).toEqual({ line: 2, column: 1 })
    expect(lineColumnAt("ab\ncd", 99)).toEqual({ line: 2, column: 3 })
    expect(lineColumnAt("ab", -5)).toEqual({ line: 1, column: 1 })
  })
})

describe("formatJson", () => {
  it("合法：排版后返回", () => {
    expect(formatJson('{"a":[1,2]}')).toEqual({ ok: true, text: '{\n  "a": [\n    1,\n    2\n  ]\n}', skippedLines: [] })
  })

  it("不合法：不返回排版结果，给出行列和原因", () => {
    const r = formatJson('{\n  "a": 1,\n}')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.line).toBe(3)
      expect(r.column).toBe(1)
      expect(r.message).toContain("尾逗号")
    }
  })

  it("空文件：说文件是空的，没有行列", () => {
    const r = formatJson("")
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) {
      expect(r.message).toContain("空")
      expect(r.line).toBe(1)
    }
  })
})

describe("formatJsonLines", () => {
  it("每条记录各自排版，记录之间空一行", () => {
    const r = formatJsonLines('{"a":1}\n[1,2]\n"x"\n')
    expect(r).toEqual({ ok: true, text: '{\n  "a": 1\n}\n\n[\n  1,\n  2\n]\n\n"x"', skippedLines: [] })
  })

  it("CRLF、空行都认；空行不产生空记录", () => {
    const r = formatJsonLines('{"a":1}\r\n\r\n   \r\n{"b":2}\r\n')
    expect(r).toEqual({ ok: true, text: '{\n  "a": 1\n}\n\n{\n  "b": 2\n}', skippedLines: [] })
  })

  it("夹杂的非 JSON 行原样保留，并记下是原文第几行", () => {
    const r = formatJsonLines('{"a":1}\n[INFO] started\n{"b":2}\n{bad')
    expect(r).toMatchObject({ ok: true, skippedLines: [2, 4] })
    if (r.ok) {
      expect(r.text).toContain("[INFO] started")
      expect(r.text).toContain("{bad")
      expect(r.text).toContain('  "b": 2')
    }
  })

  it("一条合法的都没有：失败，指出第一处错在哪一行", () => {
    const r = formatJsonLines("hello\nworld")
    expect(r).toMatchObject({ ok: false, line: 1 })
  })

  it("全是空行：说文件是空的", () => {
    expect(formatJsonLines("\n\n  \n")).toMatchObject({ ok: false, message: expect.stringContaining("空") })
  })

  it("formatJsonFor 按种类分发", () => {
    expect(formatJsonFor("json", '{"a":1}')).toMatchObject({ ok: true })
    expect(formatJsonFor("jsonl", '{"a":1}\n{"a":2}')).toMatchObject({ ok: true, text: expect.stringContaining("\n\n") })
    expect(formatJsonFor("json", '{"a":1}\n{"a":2}')).toMatchObject({ ok: false }) // 两个值挤在一个 json 文件里不合法
  })
})

describe("jsonFormatKind", () => {
  it("json 是整个一个值；jsonl / ndjson 逐行；其他（含 jsonc、json5）不提供", () => {
    expect(jsonFormatKind("a.json")).toBe("json")
    expect(jsonFormatKind("C:\\x\\A.JSON")).toBe("json")
    expect(jsonFormatKind("log.jsonl")).toBe("jsonl")
    expect(jsonFormatKind("log.ndjson")).toBe("jsonl")
    for (const name of ["a.jsonc", "a.json5", "a.yaml", ".eslintrc", "json", "a.json.bak", "a.txt"]) {
      expect(jsonFormatKind(name), name).toBeUndefined()
    }
  })
})

describe("shouldDefaultToFormatted", () => {
  const minified = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `n${i}` })) })
  const pretty = JSON.stringify(JSON.parse(minified), null, 2)

  it("压成一行的 json：默认显示格式化后的", () => {
    expect(minified.length).toBeGreaterThan(200)
    expect(shouldDefaultToFormatted("json", minified, false)).toBe(true)
    expect(shouldDefaultToFormatted("json", minified + "\n", false)).toBe(true)
  })

  it("已经排好版的：原样显示，不替用户改排版", () => {
    expect(shouldDefaultToFormatted("json", pretty, false)).toBe(false)
  })

  it("不到 200 个字符的单行：不值得动，原样（哪怕只有一行）", () => {
    const oneLine = JSON.stringify({ k: "x".repeat(150) })
    expect(oneLine.length).toBeGreaterThan(120)
    expect(oneLine.length).toBeLessThanOrEqual(200)
    expect(shouldDefaultToFormatted("json", oneLine, false)).toBe(false)
    const over = JSON.stringify({ k: "x".repeat(250) })
    expect(shouldDefaultToFormatted("json", over, false)).toBe(true)
  })

  it("小文件、jsonl、不提供格式化的类型：原样", () => {
    expect(shouldDefaultToFormatted("json", '{"a":1}', false)).toBe(false)
    expect(shouldDefaultToFormatted("jsonl", minified, false)).toBe(false)
    expect(shouldDefaultToFormatted(undefined, minified, false)).toBe(false)
  })

  it("从对话里点进来要定位到某一行：原样（格式化后行号对不上）", () => {
    expect(shouldDefaultToFormatted("json", minified, true)).toBe(false)
  })

  it("几行但每行都很长：也算压缩过的", () => {
    const text = [minified, minified, minified].join("\n")
    expect(shouldDefaultToFormatted("json", text, false)).toBe(true)
  })
})
