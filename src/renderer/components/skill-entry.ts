/**
 * Skill 目录里「新建文件 / 新建文件夹」用到的纯函数：名字校验、同名检查、展开状态的 key。
 * 单独成文件是为了能在 node 里直接测，不依赖 DOM。
 */

export type SkillEntryKind = "file" | "folder"

/** Windows 的保留设备名：写这些名字的文件不会报错，但也不会真的落盘 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/

export type EntryNameResult = { ok: true; name: string } | { ok: false; error: string }

/**
 * 校验用户输入的名字。允许用 `/` 一次建多层（如 `scripts/util.py`），`\` 会当成 `/`。
 * 拒绝：空名、空路径段、`.` / `..`、跨平台非法字符、Windows 保留名、以点或空格结尾的路径段。
 */
export function validateEntryName(raw: string): EntryNameResult {
  const name = raw.trim().replace(/\\/g, "/")
  if (!name) return { ok: false, error: "请输入名称" }
  const segments = name.split("/")
  for (const seg of segments) {
    if (seg === "") return { ok: false, error: "路径里不能有空的一段（开头、结尾或连续的 /）" }
    if (seg === "." || seg === "..") return { ok: false, error: "路径里不能有 . 或 .." }
    if (ILLEGAL_CHARS.test(seg)) return { ok: false, error: `名称里不能包含 < > : " | ? * 这些字符` }
    if (/[. ]$/.test(seg)) return { ok: false, error: `「${seg}」不能以点或空格结尾` }
    if (WINDOWS_RESERVED.test(seg)) return { ok: false, error: `「${seg}」是系统保留名，换一个` }
  }
  return { ok: true, name: segments.join("/") }
}

export function joinEntryPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** 对话框里「位置：」显示的目录，总是以单个 / 结尾（建在 Skill 根目录时 parentPath 为空） */
export function locationLabel(skillPath: string, parentPath: string): string {
  return parentPath ? `${skillPath}/${parentPath}/` : `${skillPath}/`
}

/**
 * 在 children 这一层树里检查 relPath 能不能新建。
 * 同名按大小写不敏感比较：Windows / macOS 的文件系统不分大小写，只看大小写不同的话会被悄悄覆盖。
 * 返回 null 表示可以建；否则返回要给用户看的原因。
 */
export function findEntryConflict(children: SkillTreeNode[] | undefined, relPath: string): string | null {
  const segments = relPath.split("/")
  let level = children ?? []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].toLowerCase()
    const node = level.find((n) => n.name.toLowerCase() === seg)
    // 这一段不存在，说明它和后面的都是新的，不会冲突
    if (!node) return null
    const here = segments.slice(0, i + 1).join("/")
    if (i === segments.length - 1) return `已存在同名${node.type === "directory" ? "文件夹" : "文件"}「${here}」`
    if (node.type === "file") return `「${here}」是文件，不能在它下面新建`
    level = node.children ?? []
  }
  return null
}

/** 技能行的展开状态 key（技能路径可能带多层，如 group/my-skill） */
export function skillExpandKey(rootId: string, skillPath: string): string {
  return `${rootId}:${skillPath}`
}

/** 技能内某个文件夹的展开状态 key */
export function dirExpandKey(rootId: string, skillPath: string, relPath: string): string {
  return `${rootId}:${skillPath}/${relPath}`
}

/** 新建了 relPath 之后，要展开的所有祖先 key，这样新建出来的东西立刻看得见 */
export function ancestorExpandKeys(rootId: string, skillPath: string, relPath: string): string[] {
  const keys = [skillExpandKey(rootId, skillPath)]
  const dirs = relPath.split("/").slice(0, -1)
  for (let i = 1; i <= dirs.length; i++) keys.push(dirExpandKey(rootId, skillPath, dirs.slice(0, i).join("/")))
  return keys
}

/** relPath 是 target 本身，或在 target 目录之下 */
export function isSameOrInside(relPath: string, target: string): boolean {
  return relPath === target || relPath.startsWith(target + "/")
}
