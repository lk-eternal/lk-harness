import { describe, expect, it } from "vitest"
import {
  feishuProjectDetailUrl,
  mergeRelatedDocUrls,
  extractHttpUrls,
} from "../src/shared/meegle-project-picker.js"

describe("meegle-project-picker", () => {
  it("builds detail url", () => {
    expect(feishuProjectDetailUrl("wk-dm", "story", "6977039628")).toBe(
      "https://project.feishu.cn/wk-dm/story/detail/6977039628",
    )
  })

  it("merges wiki and tech doc without dup", () => {
    const wiki = "https://wukongedu.feishu.cn/wiki/AAA?from=x"
    const tech = "https://wukongedu.feishu.cn/docx/BBB"
    expect(mergeRelatedDocUrls(wiki, tech)).toBe(`${wiki}, ${tech}`)
    expect(mergeRelatedDocUrls(wiki, wiki)).toBe(wiki)
  })

  it("extracts urls from markdown", () => {
    const md = "[link](https://wukongedu.feishu.cn/wiki/CCC) text"
    expect(extractHttpUrls(md)).toEqual([ "https://wukongedu.feishu.cn/wiki/CCC" ])
  })
})
