import { describe, expect, it } from "vitest"
import { canRebindSessionDir, chatDirOptions, planDirChoice } from "../src/shared/app-chat-types.js"

const APP = "ch_app|chat"
const TEMP = (n: number) => `${APP}::C:\\Users\\me\\AppData\\Roaming\\lk-harness\\workspaces\\temp_${n}`
const DIR = (d: string) => `${APP}::${d}`

type Tab = { sessionKey: string; kind: string; boundDir?: string }
const tab = (sessionKey: string, kind = "dir", boundDir?: string): Tab => ({ sessionKey, kind, ...(boundDir ? { boundDir } : {}) })
const options = (tabs: Tab[]) => chatDirOptions(tabs, (t) => t.boundDir)

describe("canRebindSessionDir：在会话里选目录，是改本会话的目录还是新开会话", () => {
  it("还没开始的临时会话：直接改它的目录", () => {
    expect(canRebindSessionDir(TEMP(1730000000000), false)).toBe(true)
  })

  it("临时会话一开始就不能再换（SDK 续聊要求 cwd 不变）：只能新开会话", () => {
    expect(canRebindSessionDir(TEMP(1730000000000), true)).toBe(false)
  })

  it("键里带真实目录的会话（常用目录）目录就是它的身份：开没开始都不能改", () => {
    expect(canRebindSessionDir(DIR("D:\\ws\\lk"), false)).toBe(false)
    expect(canRebindSessionDir(DIR("D:\\ws\\lk"), true)).toBe(false)
  })

  it("项目、定时任务这类不是目录的会话也不能改", () => {
    expect(canRebindSessionDir(`${APP}::project_abc123`, false)).toBe(false)
    expect(canRebindSessionDir("temp_12345678", false)).toBe(false)
  })
})

describe("planDirChoice：选了一个目录之后做什么（桌面端和手机端共用）", () => {
  it("选的就是当前目录（写法不同也算）：什么都不做", () => {
    expect(planDirChoice({ sessionKey: DIR("D:\\ws\\lk"), started: true, currentDir: "D:\\ws\\lk", chosen: "d:/ws/lk/" })).toBe("same")
    expect(planDirChoice({ sessionKey: TEMP(1), started: false, currentDir: "D:\\ws\\lk", chosen: "D:\\ws\\lk" })).toBe("same")
  })

  it("还没开始的临时会话选了别的目录：改它自己的目录", () => {
    expect(planDirChoice({ sessionKey: TEMP(1), started: false, currentDir: undefined, chosen: "D:\\ws\\lk" })).toBe("rebind")
    expect(planDirChoice({ sessionKey: TEMP(1), started: false, currentDir: "D:\\ws\\a", chosen: "D:\\ws\\b" })).toBe("rebind")
  })

  it("已经开始的临时会话、目录就是身份的常用目录会话：用这个目录新开一个会话", () => {
    expect(planDirChoice({ sessionKey: TEMP(1), started: true, currentDir: "D:\\ws\\a", chosen: "D:\\ws\\b" })).toBe("new-session")
    expect(planDirChoice({ sessionKey: DIR("D:\\ws\\lk"), started: false, currentDir: "D:\\ws\\lk", chosen: "D:\\ws\\other" })).toBe("new-session")
  })

  it("没选过目录的临时会话已经开始了，选目录同样新开（目录不能中途换）", () => {
    expect(planDirChoice({ sessionKey: TEMP(1), started: true, currentDir: undefined, chosen: "D:\\ws\\lk" })).toBe("new-session")
  })
})

describe("chatDirOptions：目录菜单", () => {
  it("常用目录会话和选了目录的临时会话，都把各自的目录列出来", () => {
    const list = options([tab(DIR("D:\\ws\\lk")), tab(TEMP(1), "dir", "D:\\work\\proj-a")])
    expect(list).toEqual([
      { name: "lk", dir: "D:\\ws\\lk" },
      { name: "proj-a", dir: "D:\\work\\proj-a" },
    ])
  })

  it("同一个目录有多个会话，菜单里只列一次（写法不同也算同一个）", () => {
    const list = options([
      tab(DIR("D:\\ws\\lk")),
      tab(TEMP(1), "dir", "d:/ws/lk/"),
      tab(TEMP(2), "dir", "D:\\ws\\lk"),
    ])
    expect(list.map((o) => o.dir)).toEqual(["D:\\ws\\lk"])
  })

  it("还没选目录的临时会话不贡献选项（它的临时文件夹对用户不可见）", () => {
    expect(options([tab(TEMP(1)), tab(TEMP(2))])).toEqual([])
  })

  it("只看主目录和目录会话：项目、定时任务、其它会话不进目录菜单", () => {
    const list = options([
      tab(DIR("D:\\ws\\main"), "main"),
      tab(`${APP}::project_abc123`, "project"),
      tab("task-uuid-1", "task"),
      tab("temp_12345678", "temp"),
      tab(DIR("D:\\ws\\other"), "other"),
    ])
    expect(list.map((o) => o.dir)).toEqual(["D:\\ws\\main"])
  })
})
