import { describe, expect, it } from "vitest"
import { GitLabFlowHubClient, parseHubRepoUrl } from "../../src/shared/flow-hub-gitlab.js"

describe("parseHubRepoUrl", () => {
  it("parses full gitlab URL", () => {
    const r = parseHubRepoUrl("https://gitlab.example.com/internal-shared/flow-hub")
    expect(r).toEqual({
      host: "https://gitlab.example.com",
      projectPath: "internal-shared/flow-hub",
    })
  })

  it("strips trailing slash and .git", () => {
    const r = parseHubRepoUrl("https://gitlab.com/foo/bar.git/")
    expect(r?.projectPath).toBe("foo/bar")
  })

  it("returns null for invalid", () => {
    expect(parseHubRepoUrl("")).toBeNull()
    expect(parseHubRepoUrl("not-a-url")).toBeNull()
  })
})

describe("GitLabFlowHubClient", () => {
  it("commitFiles uses repository/commits endpoint", async () => {
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = async (input) => {
      calls.push(String(input))
      if (String(input).includes("/projects/internal")) {
        return new Response(JSON.stringify({ id: 1, default_branch: "main" }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: "abc123" }), { status: 200 })
    }
    try {
      const client = new GitLabFlowHubClient("https://gitlab.example.com", "token")
      await client.resolveProjectId("group/proj")
      await client.commitFiles(1, "msg", [{ path: "catalog.json", content: "{}", exists: false }])
      expect(calls.some((u) => u.includes("/repository/commits"))).toBe(true)
    } finally {
      globalThis.fetch = orig
    }
  })

  it("commitFiles surfaces friendly 403 message", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: "403 Forbidden - You are not allowed to push into this branch" }),
      { status: 403 },
    )
    try {
      const client = new GitLabFlowHubClient("https://gitlab.example.com", "token")
      await expect(client.commitFiles(1, "msg", [{ path: "a.json", content: "{}", exists: false }]))
        .rejects.toThrow("无权限推送到 main 分支")
    } finally {
      globalThis.fetch = orig
    }
  })
})
