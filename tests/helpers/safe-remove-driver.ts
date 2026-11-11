/**
 * 在 Electron 的 Node 里跑的验证脚本。
 * 由 tests/safe-remove-electron.test.ts 用 esbuild 打包成 CJS，再用 ELECTRON_RUN_AS_NODE=1 启动：
 *   electron driver.cjs <临时目录>
 * 往 stdout 写一行 JSON：各场景的观察结果，断言在测试里做。
 *
 * 为什么要这样：Electron 41（Node 24.14）的 fs.rmSync 删链接会顺着链接删掉原目录的内容，
 * 普通 Node 里没有这个问题，vitest 默认跑在普通 Node 上，永远复现不了。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { removeNoFollow } from "../../src/shared/safe-remove"
import { deleteHarnessSkill } from "../../src/shared/skill-admin"

const base = process.argv[2]
if (!base) throw new Error("usage: driver <dir>")

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
function junction(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at, "junction")
    return true
  } catch {
    return false
  }
}
const exists = (p: string) => {
  try { fs.lstatSync(p); return true } catch { return false }
}
const read = (p: string) => (exists(p) ? fs.readFileSync(p, "utf-8") : null)

async function main(): Promise<void> {
  const out: Record<string, unknown> = {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    platform: process.platform,
  }

  // 前提（对照组）：直接 fs.rmSync 删链接，原目录的内容会不会被带走
  {
    const target = path.join(base, "control", "real")
    write(path.join(target, "SKILL.md"), "x")
    if (!junction(target, path.join(base, "control", "link"))) {
      out.cannotCreateLinks = true
      process.stdout.write(JSON.stringify(out))
      return
    }
    fs.rmSync(path.join(base, "control", "link"), { recursive: true, force: true })
    out.naiveRmSyncEmptiedTarget = !exists(path.join(target, "SKILL.md"))
  }

  // 1 顶层链接
  {
    const real = path.join(base, "s1", "real")
    write(path.join(real, "SKILL.md"), "原件")
    write(path.join(real, "scripts", "run.sh"), "原件脚本")
    const at = path.join(base, "s1", "link")
    junction(real, at)
    const r = await removeNoFollow(at)
    out.topLink = {
      result: r,
      linkGone: !exists(at),
      skillMd: read(path.join(real, "SKILL.md")),
      script: read(path.join(real, "scripts", "run.sh")),
    }
  }

  // 2 文件夹里嵌套了链接
  {
    const outside = path.join(base, "s2", "outside")
    write(path.join(outside, "precious.txt"), "别删我")
    const skill = path.join(base, "s2", "skill")
    write(path.join(skill, "SKILL.md"), "x")
    junction(outside, path.join(skill, "references"))
    const r = await removeNoFollow(skill)
    out.nestedLink = { result: r, skillGone: !exists(skill), precious: read(path.join(outside, "precious.txt")) }
  }

  // 3 manage_skills 删一个链接过来的 Skill（daemon 在应用里就是这个运行时）
  {
    const root = path.join(base, "s3", "skills")
    fs.mkdirSync(root, { recursive: true })
    const real = path.join(base, "s3", "elsewhere", "linked")
    write(path.join(real, "SKILL.md"), "原件")
    write(path.join(real, "scripts", "run.sh"), "原件脚本")
    junction(real, path.join(root, "linked"))
    const r = await deleteHarnessSkill(root, "linked")
    out.adminLink = {
      result: r,
      linkGone: !exists(path.join(root, "linked")),
      skillMd: read(path.join(real, "SKILL.md")),
      script: read(path.join(real, "scripts", "run.sh")),
    }
  }

  // 4 manage_skills 删一个普通 Skill，它里面嵌套了指向外面的链接
  {
    const root = path.join(base, "s4", "skills")
    const outside = path.join(base, "s4", "outside")
    write(path.join(outside, "precious.txt"), "别删我")
    write(path.join(root, "plain", "SKILL.md"), "x")
    junction(outside, path.join(root, "plain", "references"))
    const r = await deleteHarnessSkill(root, "plain")
    out.adminNested = { result: r, skillGone: !exists(path.join(root, "plain")), precious: read(path.join(outside, "precious.txt")) }
  }

  process.stdout.write(JSON.stringify(out))
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e))
  process.exit(1)
})
