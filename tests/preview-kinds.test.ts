import { describe, expect, it } from "vitest"
import {
  baseName, canOpenWithDefaultApp, fileExt, isPreviewable, isTextKind, previewLanguages, previewMime, previewTypeOf,
} from "../src/shared/preview-kinds"

describe("previewTypeOf", () => {
  it.each([
    ["notes.txt", "text", undefined],
    ["server.LOG", "text", undefined],
    ["README", "text", undefined],
    ["README.md", "markdown", undefined],
    ["page.html", "html", undefined],
    ["page.HTM", "html", undefined],
    ["data.csv", "csv", undefined],
    ["data.tsv", "csv", undefined],
    ["a.png", "image", undefined],
    ["logo.svg", "image", undefined],
    ["doc.pdf", "pdf", undefined],
    ["song.mp3", "audio", undefined],
    ["clip.mp4", "video", undefined],
    ["clip.webm", "video", undefined],
    ["app.ts", "code", "typescript"],
    ["App.TSX", "code", "typescript"],
    ["main.py", "code", "python"],
    ["config.yml", "code", "yaml"],
    ["data.json", "code", "json"],
    ["run.ps1", "code", "powershell"],
    ["deploy.sh", "code", "bash"],
    ["Dockerfile", "code", "dockerfile"],
    ["Makefile", "code", "makefile"],
    [".env", "code", "ini"],
    [".env.production", "code", "ini"],
    [".gitignore", "text", undefined],
  ] as const)("%s → %s", (file, kind, lang) => {
    const t = previewTypeOf(file)
    expect(t.kind).toBe(kind)
    expect(t.lang).toBe(lang)
  })

  it("Windows 和 POSIX 路径都只看文件名", () => {
    expect(previewTypeOf("D:\\work\\src\\main.go")).toEqual({ kind: "code", lang: "go" })
    expect(previewTypeOf("/home/me/docs/report.pdf").kind).toBe("pdf")
    // 目录名里有扩展名不影响
    expect(previewTypeOf("/tmp/a.png/notes").kind).toBe("unsupported")
  })

  it("不认识的类型一律 unsupported，不当文本读", () => {
    for (const f of ["a.exe", "a.zip", "a.docx", "a.xlsx", "a.pptx", "a.doc", "a.bin", "archive.tar.gz", "noext", "x."]) {
      expect(previewTypeOf(f).kind, f).toBe("unsupported")
    }
  })
})

describe("fileExt / baseName", () => {
  it("扩展名小写、不带点；只有点开头的名字没有扩展名", () => {
    expect(fileExt("A.B.TXT")).toBe("txt")
    expect(fileExt(".gitignore")).toBe("")
    expect(fileExt("noext")).toBe("")
    expect(fileExt("C:\\x.y\\file")).toBe("")
  })
  it("baseName 认两种分隔符，忽略末尾分隔符", () => {
    expect(baseName("C:\\a\\b.txt")).toBe("b.txt")
    expect(baseName("/a/b/")).toBe("b")
    expect(baseName("plain")).toBe("plain")
  })
})

describe("kind 辅助判断", () => {
  it("isPreviewable / isTextKind", () => {
    expect(isPreviewable("unsupported")).toBe(false)
    expect(isPreviewable("pdf")).toBe(true)
    for (const k of ["text", "code", "markdown", "html", "csv"] as const) expect(isTextKind(k)).toBe(true)
    for (const k of ["image", "pdf", "audio", "video", "unsupported"] as const) expect(isTextKind(k)).toBe(false)
  })
})

describe("canOpenWithDefaultApp", () => {
  it("文档、图片、音视频、压缩包可以交给默认程序", () => {
    for (const f of ["a.pdf", "REPORT.PDF", "a.docx", "a.xlsx", "a.pptx", "a.zip", "a.png", "a.mp4", "a.mp3", "a.txt", "a.md"]) {
      expect(canOpenWithDefaultApp(f), f).toBe(true)
    }
  })
  it("脚本、可执行文件、网页、快捷方式一律不行（防一键运行 Agent 发来的东西）", () => {
    for (const f of [
      "a.exe", "a.bat", "a.cmd", "a.ps1", "a.js", "a.mjs", "a.vbs", "a.hta", "a.msi", "a.lnk", "a.jar", "a.scr",
      "a.sh", "a.py", "a.html", "a.htm", "a.svg", "a.url", "noext", ".bashrc",
    ]) {
      expect(canOpenWithDefaultApp(f), f).toBe(false)
    }
  })
})

describe("previewMime", () => {
  it("常见类型有对应 Content-Type，不认识的是 octet-stream", () => {
    expect(previewMime("a.pdf")).toBe("application/pdf")
    expect(previewMime("a.mp4")).toBe("video/mp4")
    expect(previewMime("a.html")).toBe("text/html; charset=utf-8")
    expect(previewMime("a.SVG")).toBe("image/svg+xml")
    expect(previewMime("a.weird")).toBe("application/octet-stream")
  })
})

describe("previewLanguages", () => {
  it("包含扩展名表和约定文件名里用到的语言，且没有重复", () => {
    const langs = previewLanguages()
    expect(langs).toEqual(expect.arrayContaining(["typescript", "python", "dockerfile", "makefile", "ruby", "groovy", "ini"]))
    expect(new Set(langs).size).toBe(langs.length)
  })
})
