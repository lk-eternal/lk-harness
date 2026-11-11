import * as path from "node:path"
import { isPathInside } from "./path-inside.js"

/**
 * manage_skills 传进来的 name → root 下对应的 Skill 目录。拿不到合法目录返回 null。
 *
 * name 是 AI 给的，不能直接拼路径：`..`、`.`、绝对路径、盘符都会指到 root 外面或 root 自己，
 * 删除时就是把别的目录甚至整个 Skill 根目录删掉。
 * 和设置页一致：允许用 `/`（或 `\`）写多层，如 `group/foo`。
 */
export function resolveSkillDirUnder(root: string, rawName: string): string | null {
  // name 来自 JSON，类型声明是 string 但运行时可能是数字、对象
  if (typeof rawName !== "string") return null
  const name = rawName.trim().replace(/\\/g, "/")
  if (!name) return null
  const segments = name.split("/")
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null
    // 盘符（C:）和 NUL 等控制字符：Windows 上 path.resolve 会把它当成另一个盘
    if (/[:\u0000-\u001f]/.test(seg)) return null
  }
  const dir = path.resolve(root, ...segments)
  if (path.resolve(root) === dir || !isPathInside(root, dir)) return null
  return dir
}
