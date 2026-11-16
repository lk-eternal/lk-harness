#!/usr/bin/env node
/**
 * 给 CI 里 `cap add android` 生成的安卓壳加上「输入法弹出时把输入框顶上来」。
 *
 * 背景：安卓 15 起应用强制边到边，输入法弹出时系统不再缩小 WebView，键盘会盖住页面底部的输入框。
 * Capacitor 7.6 的壳对此没有处理（adjustMarginsForEdgeToEdge 只管系统栏，不管键盘）。
 *
 * 做两件事：
 *  1. AndroidManifest.xml 里给 .MainActivity 声明 windowSoftInputMode=adjustResize：
 *     不声明时系统在 adjustResize 和 adjustPan 之间自己挑，挑到 pan 时窗口会被整个顶上去，和下面的做法叠加就多让一次。
 *  2. 用 scripts/android/MainActivity.java.tpl 替换空的 MainActivity，由它按输入法高度给内容区底部让位。
 *
 * 用法：node scripts/patch-android-ime.cjs <android 目录>
 * 模板和预期不一致（比如 Capacitor 升级后 MainActivity 不再是空类）时直接失败，不悄悄覆盖。
 */
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const TEMPLATE_PATH = path.join(__dirname, "android", "MainActivity.java.tpl")
/** 模板里的标记；已经带它的 MainActivity 视为打过补丁 */
const MARKER = "lk-harness-ime-padding"
const SOFT_INPUT_ATTR = "android:windowSoftInputMode"

/** 给 AndroidManifest.xml 里的 .MainActivity 加上 adjustResize；已经有就原样返回 */
function patchManifest(xml) {
  const tag = /<activity\b[^>]*?android:name="\.MainActivity"[^>]*>/s.exec(xml)
  if (!tag) throw new Error('AndroidManifest.xml 里没找到 android:name=".MainActivity" 的 <activity>，Capacitor 模板可能变了')

  const existing = new RegExp(`${SOFT_INPUT_ATTR}="([^"]*)"`).exec(tag[0])
  if (existing) {
    if (existing[1].split("|").includes("adjustResize")) return xml
    throw new Error(`.MainActivity 已经声明了 ${SOFT_INPUT_ATTR}="${existing[1]}"，不是 adjustResize，请人工确认后再改补丁`)
  }

  const patchedTag = tag[0].replace('android:name=".MainActivity"', `android:name=".MainActivity"\n            ${SOFT_INPUT_ATTR}="adjustResize"`)
  return xml.slice(0, tag.index) + patchedTag + xml.slice(tag.index + tag[0].length)
}

/** 用模板生成新的 MainActivity.java；包名沿用原文件的 package 行 */
function renderMainActivity(original, template) {
  if (original.includes(MARKER)) return original

  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(original)
  if (!pkg) throw new Error("MainActivity.java 里没找到 package 声明")
  // 只替换 Capacitor 模板里那个空类；用户自己改过就别覆盖
  if (!/public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/.test(original)) {
    throw new Error("MainActivity.java 不是 Capacitor 模板的空类，补丁不敢直接覆盖，请人工合并")
  }
  if (!template.includes("__PACKAGE__")) throw new Error("MainActivity.java.tpl 里没有 __PACKAGE__ 占位符")
  return template.replaceAll("__PACKAGE__", pkg[1])
}

/** 在目录里找唯一的 MainActivity.java */
function findMainActivity(javaRoot) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "MainActivity.java") found.push(full)
    }
  }
  walk(javaRoot)
  if (found.length !== 1) throw new Error(`在 ${javaRoot} 下应该只有一个 MainActivity.java，实际找到 ${found.length} 个`)
  return found[0]
}

/** 对 android 工程目录打补丁，返回改动的文件路径 */
function patchAndroidProject(androidDir) {
  const manifestPath = path.join(androidDir, "app", "src", "main", "AndroidManifest.xml")
  const javaRoot = path.join(androidDir, "app", "src", "main", "java")
  if (!fs.existsSync(manifestPath)) throw new Error(`没找到 ${manifestPath}`)
  if (!fs.existsSync(javaRoot)) throw new Error(`没找到 ${javaRoot}`)

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8")
  const activityPath = findMainActivity(javaRoot)

  // 两个文件都先算好再写：任何一个对不上就一个都不改
  const manifestBefore = fs.readFileSync(manifestPath, "utf8")
  const manifestAfter = patchManifest(manifestBefore)
  const activityBefore = fs.readFileSync(activityPath, "utf8")
  const activityAfter = renderMainActivity(activityBefore, template)

  const changed = []
  if (manifestAfter !== manifestBefore) {
    fs.writeFileSync(manifestPath, manifestAfter)
    changed.push(manifestPath)
  }
  if (activityAfter !== activityBefore) {
    fs.writeFileSync(activityPath, activityAfter)
    changed.push(activityPath)
  }

  // 写完再读一遍确认，别让一个没生效的补丁混进发布包
  if (!fs.readFileSync(activityPath, "utf8").includes(MARKER)) throw new Error("MainActivity.java 写入后没有补丁标记")
  if (!/android:windowSoftInputMode="[^"]*adjustResize/.test(fs.readFileSync(manifestPath, "utf8"))) {
    throw new Error("AndroidManifest.xml 写入后没有 adjustResize")
  }
  return changed
}

module.exports = { patchManifest, renderMainActivity, findMainActivity, patchAndroidProject, MARKER, TEMPLATE_PATH }

if (require.main === module) {
  const androidDir = process.argv[2]
  if (!androidDir) {
    console.error("用法: node scripts/patch-android-ime.cjs <android 目录>")
    process.exit(2)
  }
  try {
    const changed = patchAndroidProject(path.resolve(androidDir))
    console.log(changed.length ? `已打输入法补丁：\n${changed.map((f) => `  ${f}`).join("\n")}` : "输入法补丁已经打过，没有改动")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`::error title=安卓输入法补丁失败::${msg}`)
    process.exit(1)
  }
}
