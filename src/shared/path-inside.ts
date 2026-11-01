import * as path from "node:path"

/** target 是否位于 root 目录内（含 root 自身）。按路径边界比较，避免 `/a/mobile` 误放行 `/a/mobile-evil` */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (rel === "") return true
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
}
