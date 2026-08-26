import { spawnSync } from "node:child_process"
import * as https from "node:https"
import * as http from "node:http"
import { URL } from "node:url"

export interface GitlabConfig {
  token: string
  host?: string
}

export interface CreateMrInput extends GitlabConfig {
  cwd: string
  title: string
  sourceBranch: string
  targetBranch: string
  description?: string
}

export interface CreateMrResult {
  ok: boolean
  mrUrl?: string
  error?: string
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() }
}

export function resolveGitlabProjectPath(cwd: string): { ok: true; host: string; projectPath: string } | { ok: false; error: string } {
  const remote = git(cwd, ["remote", "get-url", "origin"])
  if (!remote.ok || !remote.out) return { ok: false, error: "无法读取 origin remote" }
  const url = remote.out.trim()
  // git@host:group/repo.git  or https://host/group/repo.git
  let host = ""
  let projectPath = ""
  const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/i)
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/i)
  if (ssh) {
    host = ssh[1]
    projectPath = ssh[2]
  } else if (httpsMatch) {
    host = httpsMatch[1]
    projectPath = httpsMatch[2]
  } else {
    return { ok: false, error: `无法解析 GitLab remote: ${url}` }
  }
  return { ok: true, host, projectPath: projectPath.replace(/\\/g, "/") }
}

function requestJson(
  method: string,
  apiUrl: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(apiUrl)
    const lib = u.protocol === "http:" ? http : https
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          "PRIVATE-TOKEN": token,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8")
          let json: any = null
          try { json = JSON.parse(text) } catch { /* ignore */ }
          resolve({ status: res.statusCode || 0, json, text })
        })
      },
    )
    req.on("error", reject)
    if (data) req.write(data)
    req.end()
  })
}

/** �?MR web_url 解析 host / project path / iid */
export function parseMrUrl(mrUrl: string): { ok: true; host: string; projectPath: string; iid: number } | { ok: false; error: string } {
  const m = (mrUrl || "").trim().match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/i)
  if (!m) return { ok: false, error: `无法解析 MR URL: ${mrUrl}` }
  return { ok: true, host: m[1], projectPath: m[2], iid: Number(m[3]) }
}

export interface AcceptMrResult {
  ok: boolean
  merged?: boolean
  error?: string
}

/** 合并（accept）一个已存在�?MR；host 缺省�?MR URL 自带�?*/
export async function acceptMergeRequest(input: GitlabConfig & { mrUrl: string }): Promise<AcceptMrResult> {
  if (!input.token?.trim()) return { ok: false, error: "未配�?GitLab token（设�?�?项目工作区）" }
  const parsed = parseMrUrl(input.mrUrl)
  if (!parsed.ok) return parsed
  const host = (input.host?.trim() || parsed.host).replace(/\/$/, "")
  const api = `${host}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/merge_requests/${parsed.iid}/merge`
  try {
    const res = await requestJson("PUT", api, input.token.trim(), {})
    if (res.status >= 200 && res.status < 300) return { ok: true, merged: true }
    return { ok: false, error: `合并 MR 失败 (${res.status}): ${res.json?.message || res.text}` }
  } catch (e: any) {
    return { ok: false, error: `GitLab API 异常: ${e?.message || e}` }
  }
}

/** 只读查询 source→target 的现�?MR（优�?opened，其�?merged），不创�?*/
export async function findMergeRequest(
  input: GitlabConfig & { cwd: string; sourceBranch: string; targetBranch: string },
): Promise<{ ok: boolean; mrUrl?: string; state?: string; error?: string }> {
  if (!input.token?.trim()) return { ok: false, error: "未配�?GitLab token（设�?�?项目工作区）" }
  const parsed = resolveGitlabProjectPath(input.cwd)
  if (!parsed.ok) return parsed
  const host = (input.host?.trim() || `https://${parsed.host}`).replace(/\/$/, "")
  const projectEnc = encodeURIComponent(parsed.projectPath)
  try {
    for (const state of ["opened", "merged"]) {
      const url = `${host}/api/v4/projects/${projectEnc}/merge_requests`
        + `?source_branch=${encodeURIComponent(input.sourceBranch)}`
        + `&target_branch=${encodeURIComponent(input.targetBranch)}`
        + `&state=${state}&order_by=updated_at`
      const res = await requestJson("GET", url, input.token.trim())
      const mr = Array.isArray(res.json) ? res.json[0] : null
      if (mr?.web_url) return { ok: true, mrUrl: String(mr.web_url), state }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `GitLab API 异常: ${e?.message || e}` }
  }
}

export async function pushAndCreateMergeRequest(input: CreateMrInput): Promise<CreateMrResult> {
  if (!input.token?.trim()) return { ok: false, error: "未配�?GitLab token（设�?�?项目工作区）" }

  const push = git(input.cwd, ["push", "-u", "origin", `HEAD:${input.sourceBranch}`])
  if (!push.ok) return { ok: false, error: `git push 失败: ${push.out}` }

  const parsed = resolveGitlabProjectPath(input.cwd)
  if (!parsed.ok) return parsed

  const host = (input.host?.trim() || `https://${parsed.host}`).replace(/\/$/, "")
  const projectEnc = encodeURIComponent(parsed.projectPath)
  const api = `${host}/api/v4/projects/${projectEnc}/merge_requests`
  try {
    const res = await requestJson("POST", api, input.token.trim(), {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description || "",
      remove_source_branch: false,
    })
    if (res.status >= 200 && res.status < 300 && res.json?.web_url) {
      return { ok: true, mrUrl: String(res.json.web_url) }
    }
    // already exists �?try find
    if (res.status === 409 || /already exists/i.test(res.text)) {
      const listUrl = `${host}/api/v4/projects/${projectEnc}/merge_requests?source_branch=${encodeURIComponent(input.sourceBranch)}&state=opened`
      const list = await requestJson("GET", listUrl, input.token.trim())
      const mr = Array.isArray(list.json) ? list.json[0] : null
      if (mr?.web_url) return { ok: true, mrUrl: String(mr.web_url) }
    }
    return { ok: false, error: `创建 MR 失败 (${res.status}): ${res.json?.message || res.text}` }
  } catch (e: any) {
    return { ok: false, error: `GitLab API 异常: ${e?.message || e}` }
  }
}
