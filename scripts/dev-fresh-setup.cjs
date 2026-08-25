/**
 * 模拟首次安装：清空指定 profile 的用户数据目录后启动 dev。
 *
 * 用法:
 *   npm run dev:fresh-setup
 *   npm run dev:fresh-setup -- my-profile
 *   node scripts/dev-fresh-setup.cjs setup-test
 *
 * 数据目录（与 electron/main.ts 一致）:
 *   %APPDATA%/lk-harness-<profile>  (Windows)
 */

const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")

const PROFILE = process.argv[2] || "setup-test"
const ROOT = path.join(__dirname, "..")
const IS_WIN = process.platform === "win32"

function resolveProfileUserData(profile) {
  const home = os.homedir()
  let defaultUserData
  if (IS_WIN) {
    defaultUserData = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "lk-harness")
  } else if (process.platform === "darwin") {
    defaultUserData = path.join(home, "Library", "Application Support", "lk-harness")
  } else {
    defaultUserData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "lk-harness")
  }
  return path.join(path.dirname(defaultUserData), `lk-harness-${profile}`)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: IS_WIN,
      env: process.env,
    })
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
}

async function main() {
  const userDataDir = resolveProfileUserData(PROFILE)
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    console.log(`✓ 已清空用户数据: ${userDataDir}`)
  } else {
    console.log(`○ 用户数据目录不存在，将首次创建: ${userDataDir}`)
  }

  console.log(`→ 构建并启动 electron-vite dev --profile=${PROFILE}`)
  await run(IS_WIN ? "npm.cmd" : "npm", ["run", "build"])
  await run(
    path.join(ROOT, "node_modules", ".bin", IS_WIN ? "electron-vite.cmd" : "electron-vite"),
    ["dev", "--", `--profile=${PROFILE}`],
  )
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
