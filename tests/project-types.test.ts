import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  coerceFormMultiSelect,
  decodeRepoPair,
  decodeRepoPairOption,
  encodeRepoPair,
  encodeRepoPairOption,
  formFieldStr,
  normalizeProjectChatMode,
  parseExistingGroupChatBinding,
  projectRootDir,
  splitRepoPairValues,
  type Project,
} from "../src/shared/project-types.js"

describe("encodeRepoPairOption", () => {
  const repo = "https://gitlab.wukongedu.net/wukong/wk-knowledgebase"

  it("roundtrips branch info through base64 option value", () => {
    const opt = encodeRepoPairOption(repo, "release/1.0", "test/1.0", "develop")
    expect(opt.startsWith("b64:")).toBe(true)
    expect(decodeRepoPairOption(opt)).toMatchObject({
      path: repo,
      baseBranch: "release/1.0",
      testBranch: "test/1.0",
      developBranch: "develop",
    })
  })

  it("still decodes legacy plain encodeRepoPair values", () => {
    const legacy = encodeRepoPair(repo, "release/1.0")
    expect(decodeRepoPairOption(legacy).baseBranch).toBe("release/1.0")
  })
})

describe("coerceFormMultiSelect", () => {
  it("passes through array", () => {
    expect(coerceFormMultiSelect(["wukong-dev"])).toEqual(["wukong-dev"])
    expect(coerceFormMultiSelect(["develop", "wukong-dev"])).toEqual(["develop", "wukong-dev"])
  })

  it("splits comma-glued string from String(array)", () => {
    expect(coerceFormMultiSelect("develop,wukong-dev")).toEqual(["develop", "wukong-dev"])
  })

  it("parses JSON array string", () => {
    expect(coerceFormMultiSelect('["wukong-dev"]')).toEqual(["wukong-dev"])
  })
})

describe("formFieldStr", () => {
  it("takes first element from array", () => {
    expect(formFieldStr(["inline", "group"])).toBe("inline")
  })
})

describe("normalizeProjectChatMode", () => {
  it("maps bind and inline", () => {
    expect(normalizeProjectChatMode("bind")).toBe("bind")
    expect(normalizeProjectChatMode("inline")).toBe("inline")
    expect(normalizeProjectChatMode(undefined)).toBe("group")
    expect(normalizeProjectChatMode("other")).toBe("group")
  })
})

describe("parseExistingGroupChatBinding", () => {
  const channelId = "ch_c0130dd0"
  const oc = "oc_aa2192cfececee92d57dccd0b59980fd"

  it("accepts bare oc_ id", () => {
    expect(parseExistingGroupChatBinding(oc, channelId)).toEqual({
      chatKey: `${channelId}|${oc}`,
      rawChatId: oc,
    })
  })

  it("accepts full chatKey", () => {
    const full = `${channelId}|${oc}`
    expect(parseExistingGroupChatBinding(full, channelId)).toEqual({ chatKey: full, rawChatId: oc })
  })

  it("rejects empty or invalid", () => {
    expect(parseExistingGroupChatBinding("", channelId)).toEqual({ error: expect.any(String) })
    expect(parseExistingGroupChatBinding("ou_userxxx", channelId)).toEqual({ error: expect.any(String) })
    expect(parseExistingGroupChatBinding(oc, "")).toEqual({ error: expect.any(String) })
  })
})

describe("splitRepoPairValues", () => {
  const repo1 = "https://gitlab.wukongedu.net/wukong/cp-scheduling"
  const repo2 = "https://gitlab.wukongedu.net/wukong/wk-knowledgebase"
  const pair1 = encodeRepoPair(repo1, "release/1.36.1", "test/1.36.1", "master")
  const pair2 = encodeRepoPair(repo2, "release/1.36.1", "test/1.36.1", "master")

  it("splits comma-glued multi_select string into two pairs", () => {
    const glued = `${pair1},${pair2}`
    const list = splitRepoPairValues(glued)
    expect(list).toHaveLength(2)
    expect(decodeRepoPair(list[0])).toMatchObject({
      path: repo1,
      baseBranch: "release/1.36.1",
      testBranch: "test/1.36.1",
      developBranch: "master",
    })
    expect(decodeRepoPair(list[1])).toMatchObject({
      path: repo2,
      baseBranch: "release/1.36.1",
      developBranch: "master",
    })
  })

  it("passes through array and splits glued elements", () => {
    expect(splitRepoPairValues([pair1, pair2])).toEqual([pair1, pair2])
    expect(splitRepoPairValues([`${pair1},${pair2}`])).toHaveLength(2)
  })

  it("keeps single pair with comma-only develop branch", () => {
    const single = encodeRepoPair(repo1, "main", "", "feature,hotfix")
    expect(splitRepoPairValues(single)).toEqual([single])
    expect(decodeRepoPair(splitRepoPairValues(single)[0]).developBranch).toBe("feature,hotfix")
  })

  it("splits local drive paths glued after develop", () => {
    const local1 = encodeRepoPair("D:/repos/a", "main", "", "dev")
    const local2 = encodeRepoPair("D:/repos/b", "main")
    const glued = `${local1},${local2}`
    expect(splitRepoPairValues(glued)).toHaveLength(2)
  })
})

describe("projectRootDir", () => {
  it("uses parent of single worktree", () => {
    const p = {
      worktreePath: path.join("D:", "claw-projects", "demo", "cp-scheduling"),
      repos: [{
        repoPath: "https://example/cp-scheduling",
        baseBranch: "main",
        worktreePath: path.join("D:", "claw-projects", "demo", "cp-scheduling"),
      }],
    } as Project
    expect(projectRootDir(p)).toBe(path.join("D:", "claw-projects", "demo"))
  })

  it("finds common parent for multi-repo worktrees", () => {
    const root = path.join("D:", "claw-projects", "harness")
    const p = {
      worktreePath: path.join(root, "cp-scheduling"),
      repos: [
        {
          repoPath: "https://example/cp-scheduling",
          baseBranch: "main",
          worktreePath: path.join(root, "cp-scheduling"),
        },
        {
          repoPath: "https://example/wk-knowledgebase",
          baseBranch: "main",
          worktreePath: path.join(root, "wk-knowledgebase"),
        },
      ],
    } as Project
    expect(projectRootDir(p)).toBe(root)
  })

  it("uses the folder itself (not its parent) when the user picked an existing folder", () => {
    const folder = path.join("D:", "Documents", "周报")
    const p = { worktreePath: folder, workspaceType: "plain", externalWorkspace: true } as Project
    expect(projectRootDir(p)).toBe(folder)
    // 对照：非外部目录按约定取上一层
    expect(projectRootDir({ ...p, externalWorkspace: false } as Project)).toBe(path.join("D:", "Documents"))
  })
})
