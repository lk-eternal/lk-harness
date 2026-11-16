// ── 项目会话里的「Git 基本原则」 ──────────────────────────────────────────
// 项目里记了代码仓库时，会话开头带上这一段，防 AI 在 Git 上犯傻（把别人没上线的分支合进自己的分支、
// 为了解冲突丢掉一方改动、顺手 force push……）。它是团队级的约定，设置 → 项目里可以改，清空就不带。

export const DEFAULT_GIT_PRINCIPLES = [
  "Git 基本原则（项目有代码仓库时）：",
  "1. 分支名只用项目信息里写明的；没写的先问用户，不要猜，也不要自建 dev/test 之类的分支。",
  "2. 工作分支停在基线、测试、开发这类共享分支上时，不要直接在上面提交或推送；要改代码先问用户，或建议新建分支。",
  "3. 不要把测试/开发分支 merge 或 rebase 进工作分支（会带入他人未上线的内容）。基线分支是线上代码，可以同步进工作分支。",
  "4. 要合入测试/开发分支时，从目标分支拉临时分支，把工作分支合进去，在临时分支上解决冲突再推送，工作分支保持干净。",
  "5. 不要在本地把工作分支 merge 或 push 到基线，需要时只在用户要求下建 MR。禁止 force push。",
  "6. 解决冲突要保留双方意图，不要整文件取一方（ours/theirs）；拿不准语义就问用户；解决后先编译或测试再提交。",
  "7. reset --hard、clean、删分支、改写已推送历史这类破坏性操作，先问用户。",
].join("\n")

/** 设置里存的值 → 实际生效的文本：没设过（undefined）用默认；设成空串/纯空白就是用户主动关掉，不带 */
export function resolveGitPrinciples(configured: string | undefined | null): string {
  if (configured === undefined || configured === null) return DEFAULT_GIT_PRINCIPLES
  return configured.replace(/\r\n/g, "\n").trim()
}

/** 设置里能写的最大长度（它每个项目会话都要带一遍，别让它无限长） */
export const GIT_PRINCIPLES_MAX = 4000
