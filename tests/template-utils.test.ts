import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { renderTemplate, readTemplate, getTemplateRoot } from "../src/shared/template-utils.js"

afterEach(() => {
  delete process.env.LK_HARNESS_TEMPLATE_DIR
})

describe("renderTemplate", () => {
  it("替换 {{VAR}} 占位符", () => {
    expect(renderTemplate("你好 {{NAME}}，今天{{DAY}}", { NAME: "张三", DAY: "周一" }))
      .toBe("你好 张三，今天周一")
  })

  it("缺失变量替换为空串", () => {
    expect(renderTemplate("a={{A}} b={{B}}", { A: "1" })).toBe("a=1 b=")
  })

  it("同一变量出现多次全部替换", () => {
    expect(renderTemplate("{{X}}+{{X}}", { X: "1" })).toBe("1+1")
  })
})

describe("getTemplateRoot / readTemplate", () => {
  it("LK_HARNESS_TEMPLATE_DIR 覆盖模板根目录", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-tpl-"))
    process.env.LK_HARNESS_TEMPLATE_DIR = dir
    try {
      expect(getTemplateRoot()).toBe(dir)
      fs.writeFileSync(path.join(dir, "hello.md"), "内容 {{X}}", "utf-8")
      expect(readTemplate("hello.md")).toBe("内容 {{X}}")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("模板不存在时抛错", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-tpl-"))
    process.env.LK_HARNESS_TEMPLATE_DIR = dir
    try {
      expect(() => readTemplate("missing.md")).toThrow(/模板文件不存在/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("默认能找到仓库内置模板", () => {
    expect(readTemplate("rule/lk-harness.mdc").length).toBeGreaterThan(0)
  })
})
