import type { ProjectNodeGroupDef } from "../../../shared/project-types"

/** 模板（数据结构里叫流程组）；快捷操作带着界面用的内置默认提示词 */
export type Group = Awaited<ReturnType<typeof window.electronAPI.getProjectNodeGroups>>[number]
export type Action = Group["nodes"][number]

/** 存回去时去掉界面用的 defaultPrompt（它是内置默认提示词，不是用户写的） */
export function toStored(groups: Group[]): ProjectNodeGroupDef[] {
  return groups.map((g) => ({ ...g, nodes: g.nodes.map(({ defaultPrompt: _d, ...n }) => n) }))
}

/** 要接代码仓库的模板；老数据没写类型的当研发类（和建项目时的判断一致） */
export function isCodeGroup(g: Pick<Group, "workspace">): boolean {
  return g.workspace !== "plain"
}
