/**
 * 建项目时「选代码仓库」那一块的纯状态逻辑（桌面对话框和手机面板共用，各自只管长相）。
 * 不依赖 node / react，方便单测。
 */
import {
  isRemoteRepoUrl, repoDisplayName, repoIdentityKey,
  type ProjectRepoInput, type ProjectRepoOption,
} from "./project-app-types.js"

/** 建项时候选里的一个仓库 */
export interface RepoPickItem {
  /** 本地仓库的完整路径，或远程地址 */
  path: string
  name: string
  baseBranch: string
  checked: boolean
  remote: boolean
  /** 基线分支的输入提示（桌面端读本地仓库得到；手机端没有） */
  branches: string[]
  /** 本地仓库读过一次了（读失败也算，避免反复读） */
  inspected: boolean
  /** 这个仓库有问题时的一句话（比如文件夹被移走了），不挡着用户改选 */
  note: string
}

/** 没有别的信息时远程仓库的基线分支默认值：远程仓库没法在建项前问出默认分支，填错了克隆时会明确报错并清理干净 */
export const DEFAULT_REMOTE_BASE_BRANCH = "main"

/** 把「记住的常用仓库」变成候选，默认都不勾 */
export function repoItemsFromOptions(options: readonly ProjectRepoOption[]): RepoPickItem[] {
  const seen = new Set<string>()
  const out: RepoPickItem[] = []
  for (const o of options) {
    const key = repoIdentityKey(o.path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      path: o.path,
      name: o.name || repoDisplayName(o.path),
      baseBranch: o.baseBranch || DEFAULT_REMOTE_BASE_BRANCH,
      checked: false,
      remote: isRemoteRepoUrl(o.path),
      branches: [],
      inspected: false,
      note: "",
    })
  }
  return out
}

/**
 * 新增一个仓库并勾上；已经在候选里的只是勾上（不覆盖用户已经改过的基线分支，只补上分支提示）。
 * 返回新数组，不改入参。
 */
export function upsertPickedRepo(
  items: readonly RepoPickItem[],
  add: { path: string; baseBranch?: string; branches?: string[] },
): RepoPickItem[] {
  const path = add.path.trim()
  const key = repoIdentityKey(path)
  const idx = items.findIndex((i) => repoIdentityKey(i.path) === key)
  if (idx >= 0) {
    return items.map((i, n) => n !== idx ? i : {
      ...i,
      checked: true,
      branches: add.branches?.length ? add.branches : i.branches,
      inspected: i.inspected || !!add.branches,
      note: "",
    })
  }
  return [...items, {
    path,
    name: repoDisplayName(path),
    baseBranch: (add.baseBranch ?? "").trim() || DEFAULT_REMOTE_BASE_BRANCH,
    checked: true,
    remote: isRemoteRepoUrl(path),
    branches: add.branches ?? [],
    inspected: !!add.branches,
    note: "",
  }]
}

/** 用户填的远程仓库地址：去空白后必须是 http(s):// / ssh:// / git@ 开头；返回规范化后的地址或一句人话 */
export function parseRemoteRepoInput(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = (raw ?? "").trim()
  if (!url) return { ok: false, error: "请填仓库地址" }
  if (!isRemoteRepoUrl(url)) return { ok: false, error: "仓库地址要以 https://、ssh:// 或 git@ 开头" }
  if (/\s/.test(url)) return { ok: false, error: "仓库地址里不能有空格" }
  return { ok: true, url }
}

/** 勾上的仓库，按候选里的顺序，变成建项要的入参 */
export function picksOf(items: readonly RepoPickItem[]): ProjectRepoInput[] {
  return items.filter((i) => i.checked).map((i) => ({ repoPath: i.path, baseBranch: i.baseBranch.trim() }))
}
