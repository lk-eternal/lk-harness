import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"

// 手机端取图片/文件之前的归属校验：每张图每个文件都要查一次，在存储里直接比，不拉整段历史
const SESSION = "app_ch|app::D:\\ws\\a"
const OTHER = "app_ch|app::D:\\ws\\b"

let dir: string
let out: string
let chat: AppChat
/** 用本机路径规则拼（CI 里 Windows / macOS / Linux 都跑），不写死盘符 */
const at = (...parts: string[]) => path.join(out, ...parts)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-refs-"))
  out = path.join(dir, "out")
  chat = new AppChat(path.join(dir, "store"), () => {})
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("AppChat.referencesPath：这个路径是不是这个会话记录里的文件/图片", () => {
  it("回复里发出去的图片和文件，记录里有就算", () => {
    chat.addImage(SESSION, at("chart.png"))
    chat.addFile(SESSION, at("report.pdf"))
    expect(chat.referencesPath(SESSION, at("chart.png"))).toBe(true)
    expect(chat.referencesPath(SESSION, at("report.pdf"))).toBe(true)
  })

  it("用户自己发的图片也算", () => {
    chat.addUser(SESSION, "u1", "看看这个", [at("shot.png")])
    expect(chat.referencesPath(SESSION, at("shot.png"))).toBe(true)
  })

  it("记录里没出现过的路径不算（防止手机读取电脑上任意文件）", () => {
    chat.addImage(SESSION, at("chart.png"))
    expect(chat.referencesPath(SESSION, at("passwords.txt"))).toBe(false)
    expect(chat.referencesPath(SESSION, "")).toBe(false)
  })

  it("写法等价才算同一个：大小写、绕回上级（..）规整后比较，但不能借 .. 跳到别的文件", () => {
    chat.addFile(SESSION, at("report.pdf"))
    expect(chat.referencesPath(SESSION, at("report.pdf").toUpperCase())).toBe(true)
    expect(chat.referencesPath(SESSION, `${out}${path.sep}sub${path.sep}..${path.sep}report.pdf`)).toBe(true)
    expect(chat.referencesPath(SESSION, `${out}${path.sep}..${path.sep}secret${path.sep}report.pdf`)).toBe(false)
  })

  it("别的会话里发出去的文件不算：授权按会话分开", () => {
    chat.addFile(OTHER, at("other.pdf"))
    expect(chat.referencesPath(SESSION, at("other.pdf"))).toBe(false)
    expect(chat.referencesPath(OTHER, at("other.pdf"))).toBe(true)
  })

  it("正文、通知这类不带路径的记录不会误判", () => {
    chat.addText(SESSION, at("chart.png"))
    chat.addNotice(SESSION, at("chart.png"))
    expect(chat.referencesPath(SESSION, at("chart.png"))).toBe(false)
  })
})
