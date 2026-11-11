import { describe, expect, it } from "vitest"
import {
  clipFolds, collapseAll, computeFolds, computeJsonFolds, computeYamlFolds, displayLines, foldLanguageOf, hiddenLineCount, revealLine,
  toggleFold, visibleLines, type FoldRegion,
} from "../src/shared/preview-fold"
import { reindentJson } from "../src/shared/preview-json"

const lines = (text: string): string[] => text.split("\n")
const r = (start: number, end: number): FoldRegion => ({ start, end })

describe("computeJsonFolds", () => {
  it("排好版的对象：每个多行的 {} / [] 一个区间，藏起来的是开括号和收尾括号之间的行", () => {
    const text = [
      "{", //            0
      '  "a": 1,', //    1
      '  "b": {', //     2
      '    "c": [', //   3
      "      1,", //     4
      "      2", //      5
      "    ]", //        6
      "  },", //         7
      '  "d": []', //    8
      "}", //            9
    ].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 8), r(2, 6), r(3, 5)])
  })

  it("括号之间没有整行可藏的不算区间：{} 、[1]、紧挨着的", () => {
    expect(computeJsonFolds(lines('{\n"a":1\n}'))).toEqual([r(0, 1)]) // 只藏一行，也可以
    expect(computeJsonFolds(lines("{\n}"))).toEqual([]) // 中间一行都没有
    expect(computeJsonFolds(lines('{"a":[1,2,3]}'))).toEqual([]) // 同一行
    expect(computeJsonFolds(lines("[\n1]"))).toEqual([]) // 收尾括号和内容同一行，没有整行可藏
  })

  it("字符串里的括号不算", () => {
    const text = ['{', '  "k": "}{][",', '  "e": "\\"}",', '  "z": 1', "}"].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 3)])
  })

  it("注释里的括号不算（带注释的 json，行注释、跨行的块注释）", () => {
    const text = [
      "{", //                        0
      "  // 这里有个 { 不算", //     1
      '  "a": 1, /* ] */', //        2
      "  /* 跨行的块注释 {", //      3
      "     还没结束 } */", //       4
      '  "b": [', //                 5
      "    1", //                    6
      "  ]", //                      7
      "}", //                        8
    ].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 7), r(5, 6)])
  })

  it("块注释里有没配对的括号：不能把它当成开括号，否则会把外层括号配错", () => {
    const text = [
      "{", //                0
      "  /* 注释 {", //      1
      "     中间一行", //     2
      "     结束 [ */", //    3
      '  "a": 1,', //        4
      '  "b": [', //         5
      "    1", //            6
      "  ]", //              7
      "}", //                8
    ].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 7), r(5, 6)])
  })

  it("收尾括号和下一个开括号在同一行（}, {）：两个区间各自独立，收尾括号那行不会被藏", () => {
    const text = ["[{", '  "a": 1', "}, {", '  "b": 2', "}]"].join("\n")
    // [ 在第 0 行开、第 4 行收；{ 在第 0 行开、第 2 行收；{ 在第 2 行开、第 4 行收
    const folds = computeJsonFolds(lines(text))
    // 第 0 行上有两个开括号，只留最外层（藏到第 3 行）
    expect(folds).toEqual([r(0, 3), r(2, 3)])
    // 折叠第 2 行的区间时，第 2 行本身和收尾括号所在的第 4 行都还在
    expect(visibleLines(5, folds, new Set([2]))).toEqual([0, 1, 2, 4])
  })

  it("同一行开了好几个括号：只留最外层", () => {
    const text = ['{"a": {', '  "b": 1,', '  "c": 2', "}}"].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 2)])
  })

  it("括号对不上的收尾括号直接忽略，不影响别处", () => {
    const text = ["{", '  "a": 1', "  ]", '  "b": [', "    1,", "    2", "  ]", "}"].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 6), r(3, 5)])
  })

  it("没收尾的开括号（文件被截断）：没有区间", () => {
    expect(computeJsonFolds(lines('{\n  "a": [\n    1,\n    2'))).toEqual([])
  })

  it("records：记录之间的空行丢掉没配上的开括号，一条坏记录不连累别的记录", () => {
    // 第 0 行是一条没写完的记录（开了 [ 没收），第 7 行是另一条坏记录（多出一个 ]）。
    const text = ["[", "", "{", '  "x": 1,', '  "y": 2', "}", "", "]"].join("\n")
    expect(computeJsonFolds(lines(text), { records: true })).toEqual([r(2, 4)])
    // 不是记录模式时空行不是边界：多出来的 ] 会和第 0 行那个没收的 [ 配上，藏掉中间所有记录
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 6), r(2, 4)])
  })

  it("引号没结束的行不影响下一行", () => {
    const text = ['{', '  "a": "oops', '  "b": [', "    1", "  ]", "}"].join("\n")
    expect(computeJsonFolds(lines(text))).toEqual([r(0, 4), r(2, 3)])
  })

  it("真实格式化结果上：区间的收尾括号行一定是只有括号的那一行", () => {
    const out = reindentJson(JSON.stringify({ a: [1, { b: [2, 3], c: {} }, []], d: { e: { f: [1] } }, g: "x" }))
    const ls = lines(out)
    const folds = computeJsonFolds(ls)
    expect(folds.length).toBeGreaterThan(3)
    for (const f of folds) {
      expect(/[{[]$/.test(ls[f.start]), `开括号行 ${f.start}`).toBe(true)
      expect(/^\s*[}\]],?$/.test(ls[f.end + 1]), `收尾括号行 ${f.end + 1}：${ls[f.end + 1]}`).toBe(true)
    }
  })
})

describe("computeYamlFolds", () => {
  it("按缩进：下一行更深就是一个区间，到缩进回到同级之前", () => {
    const text = [
      "name: x", //          0
      "server:", //          1
      "  host: a", //        2
      "  ports:", //         3
      "    - 80", //         4
      "    - 443", //        5
      "  tls: true", //      6
      "other: 1", //         7
    ].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(1, 6), r(3, 5)])
  })

  it("`key:` 下面的列表项和 key 同级缩进：也算 key 的内容", () => {
    const text = ["deps:", "- a", "- b:", "    x: 1", "- c", "next: 1"].join("\n")
    // deps 藏到第 4 行；"- b:" 因为下面更深，也有自己的区间
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 4), r(2, 3)])
  })

  it("同级缩进的列表项后面接别的 key：区间到列表结束为止", () => {
    const text = ["a:", "- 1", "- 2", "b:", "- 3", "- 4"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 2), r(3, 5)])
  })

  it("列表项里嵌映射：- name: x 下面更深的行属于这一项", () => {
    const text = ["items:", "  - name: a", "    value: 1", "  - name: b", "    value: 2"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 4), r(1, 2), r(3, 4)])
  })

  it("空行和纯注释行不会把区间截断，也不会自己成为区间", () => {
    const text = ["a:", "  x: 1", "", "# 注释在更浅的缩进上", "  y: 2", "b: 1"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 4)])
  })

  it("末尾的注释和空行不算进区间", () => {
    const text = ["a:", "  x: 1", "", "# 后面的注释", "b: 1"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 1)])
  })

  it("块标量（| 和 >）：缩进更深的内容整块可折叠", () => {
    const text = ["script: |", "  echo 1", "  echo 2", "next: 1"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 2)])
  })

  it("多文档：--- 在最浅一级，把前后文档分开", () => {
    const text = ["a:", "  b: 1", "---", "c:", "  d: 2"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 1), r(3, 4)])
  })

  it("行尾注释不影响判断：`key: # 说明` 也算空值的 key", () => {
    const text = ["list: # 说明", "- a", "- b", "z: 1"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([r(0, 2)])
  })

  it("带值的 key 下面同级的 `- ` 不是它的内容", () => {
    const text = ["a: 1", "- b", "- c"].join("\n")
    expect(computeYamlFolds(lines(text))).toEqual([])
  })

  it("单行、全是平级：没有区间", () => {
    expect(computeYamlFolds(lines("a: 1\nb: 2\nc: 3"))).toEqual([])
    expect(computeYamlFolds([""])).toEqual([])
  })

  it("很深的嵌套不会爆栈，区间数等于层数", () => {
    const depth = 3000
    const text = Array.from({ length: depth }, (_, i) => `${" ".repeat(i)}k${i}:`).concat([`${" ".repeat(depth)}leaf: 1`]).join("\n")
    const folds = computeYamlFolds(lines(text))
    expect(folds).toHaveLength(depth)
    expect(folds[0]).toEqual(r(0, depth))
  })
})

describe("displayLines / computeFolds", () => {
  it("和界面分行的规则一致：统一换行，文件以换行结尾时不多出一个空行", () => {
    expect(displayLines("a\r\nb\r\n")).toEqual(["a", "b"])
    expect(displayLines("a\n\nb")).toEqual(["a", "", "b"])
    expect(displayLines("")).toEqual([""])
  })

  it("CRLF 的文件也能算对区间", () => {
    expect(computeFolds("json", '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n')).toEqual([r(0, 2)])
    expect(computeFolds("yaml", "a:\r\n  b: 1\r\n")).toEqual([r(0, 1)])
  })
})

describe("foldLanguageOf", () => {
  it("只有 json 和 yaml 支持折叠", () => {
    expect(foldLanguageOf("json")).toBe("json")
    expect(foldLanguageOf("yaml")).toBe("yaml")
    for (const lang of ["xml", "javascript", "ini", "", undefined]) expect(foldLanguageOf(lang), String(lang)).toBeUndefined()
  })
})

describe("visibleLines", () => {
  const regions = [r(0, 8), r(2, 6), r(3, 5)]

  it("没折叠：全部行", () => {
    expect(visibleLines(10, regions, new Set())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("折叠一个：藏起 start+1 .. end", () => {
    expect(visibleLines(10, regions, new Set([2]))).toEqual([0, 1, 2, 7, 8, 9])
    expect(visibleLines(10, regions, new Set([3]))).toEqual([0, 1, 2, 3, 6, 7, 8, 9])
  })

  it("折叠外层：里面已经折叠的不影响、也不会冒出来", () => {
    expect(visibleLines(10, regions, new Set([0, 2, 3]))).toEqual([0, 9])
    expect(visibleLines(10, regions, new Set([0]))).toEqual([0, 9])
  })

  it("折叠状态里有已经不存在的区间：忽略", () => {
    expect(visibleLines(10, regions, new Set([5, 99]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("区间超出行数：不会多出不存在的行", () => {
    expect(visibleLines(4, [r(0, 8)], new Set([0]))).toEqual([0])
  })
})

describe("折叠状态的操作", () => {
  const regions = [r(0, 8), r(2, 6), r(3, 5)]

  it("toggleFold：折叠 / 展开，不改原来的集合", () => {
    const empty = new Set<number>()
    const one = toggleFold(empty, 2)
    expect([...one]).toEqual([2])
    expect(empty.size).toBe(0)
    expect(toggleFold(one, 2).size).toBe(0)
  })

  it("collapseAll：所有区间的起始行", () => {
    expect([...collapseAll(regions)].sort()).toEqual([0, 2, 3])
    expect(collapseAll([]).size).toBe(0)
  })

  it("折叠全部之后展开最外层：里面的仍然是收起的，一层层往下点", () => {
    const all = collapseAll(regions)
    const afterOpen = toggleFold(all, 0)
    expect(visibleLines(10, regions, afterOpen)).toEqual([0, 1, 2, 7, 8, 9])
  })

  it("revealLine：只展开把这一行藏住的折叠", () => {
    const all = collapseAll(regions)
    // 第 4 行被 2 和 3 两层折叠藏住（也被 0 藏住）
    expect([...revealLine(all, regions, 4)].sort()).toEqual([])
    // 第 7 行只被 0 藏住
    expect([...revealLine(all, regions, 7)].sort()).toEqual([2, 3])
    // 折叠区间的起始行自己是可见的，不用展开
    expect([...revealLine(all, regions, 2)].sort()).toEqual([2, 3])
    expect(revealLine(new Set([3]), regions, 4).size).toBe(0)
    // 区间 (3,5) 藏起来的最后一行是第 5 行，它也要能被展开
    expect(revealLine(new Set([3]), regions, 5).size).toBe(0)
    // 第 6 行不在 (3,5) 里
    expect([...revealLine(new Set([3]), regions, 6)]).toEqual([3])
  })

  it("revealLine 不改原来的集合", () => {
    const c = new Set([0])
    revealLine(c, regions, 5)
    expect([...c]).toEqual([0])
  })

  it("clipFolds：只留完全落在前 N 行里的区间", () => {
    expect(clipFolds(regions, 7)).toEqual([r(2, 6), r(3, 5)])
    expect(clipFolds(regions, 9)).toEqual(regions)
    expect(clipFolds(regions, 2)).toEqual([])
    // 只渲染前 5 行（第 0..4 行）：藏到第 5 行的区间装不下
    expect(clipFolds(regions, 5)).toEqual([])
    expect(clipFolds(regions, 6)).toEqual([r(3, 5)])
  })

  it("hiddenLineCount", () => {
    expect(hiddenLineCount(r(2, 6))).toBe(4)
  })
})
