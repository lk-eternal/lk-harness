const fs = require("fs")
const path = require("path")

const PUBLISH_LINES = [
  "provider: github",
  "owner: lk-eternal",
  "repo: lk-harness",
  "vPrefixedTagName: true",
]

const CONTENT = `${PUBLISH_LINES.join("\r\n")}\r\n`

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context

  if (electronPlatformName === "win32") {
    const targetPath = path.join(appOutDir, "resources", "app-update.yml")
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, CONTENT, "utf8")
    return
  }

  if (electronPlatformName === "darwin") {
    let entries = []
    try {
      entries = fs.readdirSync(appOutDir)
    } catch {
      return
    }
    const appBundle = entries.find((e) => e.endsWith(".app"))
    if (!appBundle) {
      return
    }
    const targetPath = path.join(appOutDir, appBundle, "Contents", "Resources", "app-update.yml")
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, CONTENT, "utf8")
  }
}
