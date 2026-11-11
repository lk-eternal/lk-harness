/**
 * 设置页「项目设置」的自动保存：只把用户真正改过的那几项写回配置。
 * 整份覆盖的话，页面打开期间别处（比如手机端建项目会自动记下新仓库）改过的配置会被页面里的旧值冲掉。
 * 纯逻辑，不依赖 node / react。
 */

export interface RepoProfileRow {
  path: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
}

export interface ProjectSettingsValues {
  worktreeRoot: string
  gitlabToken: string
  gitlabHost: string
  repoProfiles: RepoProfileRow[]
  flowHubUrl: string
  flowHubToken: string
  flowHubAuthor: string
}

export type ProjectSettingsField = keyof ProjectSettingsValues

/** 去掉空行和多余空白；测试/开发分支没填就不留这个键 */
export function cleanRepoProfiles(rows: readonly RepoProfileRow[]): RepoProfileRow[] {
  return rows
    .map((p) => ({
      path: p.path.trim(),
      baseBranch: p.baseBranch.trim(),
      testBranch: p.testBranch?.trim() || undefined,
      developBranch: p.developBranch?.trim() || undefined,
    }))
    .filter((p) => p.path)
}

/** 按「改过的字段」生成要保存的配置补丁；仓库列表一并带上 repoRoots（老字段，只放路径） */
export function buildSettingsPatch(
  touched: Iterable<ProjectSettingsField>,
  values: ProjectSettingsValues,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const f of touched) {
    if (f === "repoProfiles") {
      const profiles = cleanRepoProfiles(values.repoProfiles)
      patch.repoProfiles = profiles
      patch.repoRoots = profiles.map((p) => p.path)
    } else {
      patch[f] = values[f].trim()
    }
  }
  return patch
}
