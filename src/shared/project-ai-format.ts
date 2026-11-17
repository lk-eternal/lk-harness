// manage_project 的 templates / repos / create 返回给 AI 的文字：纯函数，便于单测。

import { PROJECT_REPOS_MAX, type AiProjectCreateResult, type ProjectRepoOption, type ProjectTemplateInfo } from "./project-app-types.js"
import { WORK_BRANCH_MODES } from "./work-branch-mode.js"

const BRANCH_LABEL: Record<string, string> = Object.fromEntries(WORK_BRANCH_MODES.map((m) => [m.value, m.label]))

export function formatTemplates(list: readonly ProjectTemplateInfo[]): string {
  if (!list.length) return "📭 没有可用的项目模板（请用户先到设置里建一个）"
  const lines = [`共 ${list.length} 个项目模板（create 的 template_id 填 id）：`]
  list.forEach((t, i) => {
    lines.push("")
    lines.push(`#${i + 1} id=${t.id}「${t.name}」${t.description ? `— ${t.description}` : ""}`)
    if (t.fields.length) {
      const fields = t.fields.map((f) => {
        const hint = f.placeholder?.trim()
        return `${f.label}（${f.required ? "必填" : "可选"}${hint ? `，例：${hint}` : ""}）`
      })
      lines.push(`   要填的信息（create 的 fields，键用括号前的名字）：${fields.join("、")}`)
    } else {
      lines.push("   要填的信息：无")
    }
    lines.push(
      t.needsRepo
        ? `   代码仓库：可以接（可选，最多 ${PROJECT_REPOS_MAX} 个），默认工作分支：${BRANCH_LABEL[t.workBranchMode] ?? t.workBranchMode}`
        : "   代码仓库：不接（可以用 folder 指定一个已有文件夹，不指定就在应用的项目目录下新建）",
    )
  })
  return lines.join("\n")
}

export function formatRepos(list: readonly ProjectRepoOption[]): string {
  if (!list.length) {
    return "📭 还没有常用代码仓库。create 的 repos 里可以直接填本地 git 仓库的根目录（绝对路径）或远程地址，并给出基线分支。"
  }
  const lines = [
    `共 ${list.length} 个常用代码仓库。create 的 repos 里 repo_path 用下面的路径，base_branch 用它的基线分支（用户另有要求时按用户的）；也可以填没列在这里的本地 git 仓库根目录或远程地址：`,
  ]
  list.forEach((r, i) => {
    lines.push(`#${i + 1} ${r.name}｜${r.path}｜基线分支 ${r.baseBranch || "（未配置，需要问用户）"}｜${r.clone ? "建项时克隆一份副本" : "不克隆，只记录仓库信息"}`)
  })
  return lines.join("\n")
}

export function formatCreated(r: Extract<AiProjectCreateResult, { ok: true }>): string {
  return [
    `✅ 已创建项目「${r.name}」`,
    `项目 ID：${r.projectId}`,
    r.templateName ? `模板：${r.templateName}` : "",
    `项目目录：${r.dir}`,
    "没有进入项目会话，当前对话不受影响；也没有建飞书独立群。请把项目 ID 告诉用户，他需要时自己进入：应用里在项目列表点开，飞书/微信里发 /p use <项目 ID>。",
  ].filter(Boolean).join("\n")
}
