import { describe, expect, it } from "vitest"
import {
  baseName, canOpenWithDefaultApp, fileExt, isDocumentKind, isPreviewable, isTextKind, pathCrumbs, previewLanguages, previewMime, previewTypeOf,
  unsupportedReason,
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
    ["report.docx", "docx", undefined],
    ["REPORT.DOCX", "docx", undefined],
    ["sheet.xlsx", "xlsx", undefined],
    ["macro.xlsm", "xlsx", undefined],
    ["bundle.zip", "archive", undefined],
    ["app.jar", "archive", undefined],
    ["app.apk", "archive", undefined],
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
    for (const f of ["a.exe", "a.pptx", "a.doc", "a.xls", "a.ppt", "a.7z", "a.rar", "a.bin", "archive.tar.gz", "noext", "x."]) {
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

describe("pathCrumbs（文件夹面包屑）", () => {
  it("Windows 盘符：盘符自己是第一级，每一级都是能直接交给主进程的绝对路径", () => {
    expect(pathCrumbs("D:\\work\\docs\\img")).toEqual([
      { name: "D:", path: "D:\\" },
      { name: "work", path: "D:\\work" },
      { name: "docs", path: "D:\\work\\docs" },
      { name: "img", path: "D:\\work\\docs\\img" },
    ])
  })
  it("盘符根目录只有一级", () => {
    expect(pathCrumbs("D:\\")).toEqual([{ name: "D:", path: "D:\\" }])
  })
  it("盘符用正斜杠写：分隔符沿用原来的写法", () => {
    expect(pathCrumbs("d:/work/docs")).toEqual([
      { name: "d:", path: "d:/" },
      { name: "work", path: "d:/work" },
      { name: "docs", path: "d:/work/docs" },
    ])
  })
  it("UNC 共享：\\\\server\\share 是第一级", () => {
    expect(pathCrumbs("\\\\srv\\share\\a\\b")).toEqual([
      { name: "\\\\srv\\share", path: "\\\\srv\\share\\" },
      { name: "a", path: "\\\\srv\\share\\a" },
      { name: "b", path: "\\\\srv\\share\\a\\b" },
    ])
  })
  it("POSIX：根 / 是第一级", () => {
    expect(pathCrumbs("/Users/lk/docs")).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "lk", path: "/Users/lk" },
      { name: "docs", path: "/Users/lk/docs" },
    ])
    expect(pathCrumbs("/")).toEqual([{ name: "/", path: "/" }])
  })
  it("多余的分隔符不产生空的一级", () => {
    expect(pathCrumbs("/a//b/")).toEqual([
      { name: "/", path: "/" },
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ])
  })
})

describe("kind 辅助判断", () => {
  it("isPreviewable / isTextKind", () => {
    expect(isPreviewable("unsupported")).toBe(false)
    expect(isPreviewable("pdf")).toBe(true)
    for (const k of ["text", "code", "markdown", "html", "csv"] as const) expect(isTextKind(k)).toBe(true)
    for (const k of ["image", "pdf", "audio", "video", "docx", "xlsx", "archive", "unsupported"] as const) expect(isTextKind(k)).toBe(false)
  })
  it("isDocumentKind：只有要整个读进界面解析的 Office 新格式", () => {
    expect(isDocumentKind("docx")).toBe(true)
    expect(isDocumentKind("xlsx")).toBe(true)
    for (const k of ["text", "pdf", "archive", "csv", "unsupported"] as const) expect(isDocumentKind(k)).toBe(false)
  })
  it("docx / xlsx / 压缩包都算能预览", () => {
    for (const k of ["docx", "xlsx", "archive"] as const) expect(isPreviewable(k)).toBe(true)
  })
})

describe("unsupportedReason", () => {
  it("说得出具体原因，并指向能预览的近亲格式", () => {
    expect(unsupportedReason("a.pptx")).toContain("演示文稿")
    expect(unsupportedReason("a.doc")).toContain(".docx")
    expect(unsupportedReason("a.xls")).toContain(".xlsx")
    expect(unsupportedReason("a.7z")).toContain(".zip")
    expect(unsupportedReason("setup.exe")).toContain("程序")
  })
  it("不认识的类型给通用说法", () => {
    expect(unsupportedReason("a.weird")).toBe("暂不支持在应用内预览这种文件")
    expect(unsupportedReason("noext")).toBe("暂不支持在应用内预览这种文件")
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
