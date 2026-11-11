/**
 * 删除 Skill 前的确认文案。
 * 普通 Skill 是整个文件夹一起删；指向别处的链接（比如 ~/.claude/skills 里指向 ~/.agents/skills 的那些）
 * 只删链接本身、原文件夹不动，这两种情况删的东西不一样，确认里必须说准。
 *
 * linkTarget：null 是普通文件夹；字符串是链接指向的真实路径，空串是指向的位置已经不在了（悬空链接）。
 */
export function skillDeleteConfirm(skillPath: string, linkTarget: string | null): { title: string; message: string } {
  if (linkTarget === null) {
    return {
      title: "删除 Skill",
      message: `确定删除「${skillPath}」？整个文件夹（里面的脚本和资料也一起）都会删掉，不能恢复。`,
    }
  }
  const where = linkTarget ? `指向「${linkTarget}」` : "指向的位置已经不存在了"
  return {
    title: "删除 Skill",
    message: `「${skillPath}」是一个链接，${where}。只会删掉这个链接，原文件夹和里面的内容不会动。`,
  }
}
