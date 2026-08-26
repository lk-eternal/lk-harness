/** 路径末段标签；与 peers 中有同名末段时附父目录（�?cp-scheduling·workspace�?*/
export function pathLastSegment(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

export function disambiguatePathLabel(dir: string, peers: readonly string[]): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  const name = parts.pop() ?? dir
  const parent = parts.pop()
  const dup = peers.some((d) => d !== dir && pathLastSegment(d) === name)
  return dup && parent ? `${name}·${parent}` : name
}
