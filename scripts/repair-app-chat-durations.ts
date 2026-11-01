/**
 * 修复聊天记录里被「Resume 补发收口」改坏的回复耗时（几小时那种）。
 * 判定规则和为什么只能清掉页脚、不能算回真实耗时，见 src/shared/app-chat-duration-repair.ts。
 *
 * 用法（在仓库根目录）：
 *   npm run repair:app-chat-durations                 只预览，不改任何文件
 *   npm run repair:app-chat-durations -- --apply      真的改；每个被改的文件先备份成 <文件>.bak-<时间>
 *   npm run repair:app-chat-durations -- --data-dir D:\某个\数据目录
 *
 * 要改之前请先完全退出 LK Harness（托盘里也退出）：应用运行时会往这些文件里写，同时改会互相覆盖。
 * 脚本看到有记录文件在最近 1 分钟内被写过，会拒绝 --apply（确认应用已退出后可加 --force）。
 * 不读环境变量里的数据目录，默认就是应用平时用的那个，路径会打印出来。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { repairJsonlText } from "../src/shared/app-chat-duration-repair"

const RECENT_WRITE_MS = 60_000

function defaultDataDir(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "lk-harness")
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "lk-harness")
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "lk-harness")
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function listChatFiles(chatRoot: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(chatRoot)) return out
  for (const ch of fs.readdirSync(chatRoot, { withFileTypes: true })) {
    if (!ch.isDirectory()) continue
    for (const f of fs.readdirSync(path.join(chatRoot, ch.name))) {
      if (f.endsWith(".jsonl")) out.push(path.join(chatRoot, ch.name, f))
    }
  }
  return out
}

function main(): number {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const force = args.includes("--force")
  const dataDir = path.resolve(argValue(args, "--data-dir") ?? defaultDataDir())
  const chatRoot = path.join(dataDir, "app-chat")

  console.log(`数据目录：${dataDir}`)
  console.log(apply ? "模式：修复（会改文件，改之前先备份）" : "模式：只预览（不改任何文件，加 --apply 才会改）")
  if (!fs.existsSync(chatRoot)) {
    console.log(`没有找到聊天记录目录：${chatRoot}`)
    return 1
  }

  const files = listChatFiles(chatRoot)
  if (apply && !force) {
    const now = Date.now()
    const recent = files.filter((f) => now - fs.statSync(f).mtimeMs < RECENT_WRITE_MS)
    if (recent.length > 0) {
      console.error(`有 ${recent.length} 个记录文件在最近 1 分钟内被写过，应用可能还在运行，已停止。`)
      console.error("请先完全退出 LK Harness；确认已退出后可加 --force 重试。")
      return 2
    }
  }

  let cards = 0
  let repaired = 0
  let changedFiles = 0
  const backupStamp = stamp()
  for (const file of files) {
    const original = fs.readFileSync(file, "utf8")
    const r = repairJsonlText(original)
    cards += r.cards
    repaired += r.repaired
    if (r.repaired === 0) continue
    changedFiles++
    console.log(`  ${path.relative(chatRoot, file)}：${r.repaired} / ${r.cards} 张回复卡的耗时有问题`)
    if (!apply) continue
    fs.copyFileSync(file, `${file}.bak-${backupStamp}`)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, r.text, "utf8")
    fs.renameSync(tmp, file)
  }

  console.log(`共 ${files.length} 个记录文件、${cards} 张回复卡；${apply ? "已修复" : "有问题的"} ${repaired} 张，涉及 ${changedFiles} 个文件。`)
  if (!apply && repaired > 0) console.log("以上只是预览。确认应用已完全退出后，加 --apply 才会真的清掉这些错误的耗时（会先备份）。")
  if (apply && changedFiles > 0) console.log(`备份在各文件旁边，后缀 .bak-${backupStamp}；确认没问题后可以手动删掉。`)
  return 0
}

process.exit(main())
