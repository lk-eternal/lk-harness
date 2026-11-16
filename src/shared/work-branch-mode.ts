// 建项时克隆副本的「工作分支」选项：桌面端、手机端、主进程共用，不依赖 node，界面可以直接引。

/**
 * 建项时每个仓库的克隆副本停在哪个分支（模板上设默认值，建项时可以改）：
 * new=从基线切出一个新分支（名字不填自动起）；base / test / develop=直接停在仓库配的那个分支，
 * 没配就退到基线，基线也没有就用仓库的默认分支。
 */
export type WorkBranchMode = "new" | "base" | "test" | "develop"

export const WORK_BRANCH_MODES: { value: WorkBranchMode; label: string; hint: string }[] = [
  { value: "new", label: "新建分支", hint: "从基线切出一个新分支，适合要改代码的人" },
  { value: "base", label: "基线分支", hint: "直接停在基线分支上" },
  { value: "test", label: "测试分支", hint: "直接停在测试分支上，适合只看代码、不改代码的人" },
  { value: "develop", label: "开发分支", hint: "直接停在开发分支上" },
]

/** 脏值、缺省都当「新建分支」（存量模板的行为） */
export function normalizeWorkBranchMode(v: unknown): WorkBranchMode {
  return v === "base" || v === "test" || v === "develop" ? v : "new"
}
