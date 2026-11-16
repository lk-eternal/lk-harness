import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * CI 里给安卓壳打的「输入法弹出时输入框顶上来」补丁（scripts/patch-android-ime.cjs）。
 * 样本是 Capacitor 7.6.10 `cap add android` 生成的原文，补丁对不上模板时必须让构建失败而不是悄悄不生效。
 */
const require = createRequire(import.meta.url)
const patch = require("../scripts/patch-android-ime.cjs") as {
  patchManifest: (xml: string) => string
  renderMainActivity: (original: string, template: string) => string
  findMainActivity: (javaRoot: string) => string
  patchAndroidProject: (androidDir: string) => string[]
  MARKER: string
  TEMPLATE_PATH: string
}

const root = path.resolve(__dirname, "..")
const template = fs.readFileSync(patch.TEMPLATE_PATH, "utf8")

/** Capacitor 7.6.10 模板里的 AndroidManifest.xml（包名已被 cap add 之后的流程不影响这里的 .MainActivity） */
const STOCK_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>
    </application>

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`

const STOCK_ACTIVITY = `package com.lketernal.harness;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 在系统临时目录里搭一个和 `cap add android` 同结构的工程 */
function makeAndroidProject(opts: { manifest?: string; activity?: string; activityDir?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-ime-"))
  tmpDirs.push(dir)
  const main = path.join(dir, "app", "src", "main")
  fs.mkdirSync(main, { recursive: true })
  fs.writeFileSync(path.join(main, "AndroidManifest.xml"), opts.manifest ?? STOCK_MANIFEST)
  const javaDir = path.join(main, "java", ...(opts.activityDir ?? "com/lketernal/harness").split("/"))
  fs.mkdirSync(javaDir, { recursive: true })
  fs.writeFileSync(path.join(javaDir, "MainActivity.java"), opts.activity ?? STOCK_ACTIVITY)
  return dir
}

const manifestOf = (dir: string) => fs.readFileSync(path.join(dir, "app", "src", "main", "AndroidManifest.xml"), "utf8")
const activityOf = (dir: string) => fs.readFileSync(patch.findMainActivity(path.join(dir, "app", "src", "main", "java")), "utf8")

describe("patchManifest", () => {
  it("给 .MainActivity 加上 adjustResize，其余属性原样保留", () => {
    const out = patch.patchManifest(STOCK_MANIFEST)
    expect(out).toContain('android:windowSoftInputMode="adjustResize"')
    // 加在 .MainActivity 这个 <activity> 里，而不是别处
    const activityTag = /<activity\b[^>]*>/s.exec(out)![0]
    expect(activityTag).toContain('android:windowSoftInputMode="adjustResize"')
    for (const attr of ['android:name=".MainActivity"', 'android:launchMode="singleTask"', 'android:exported="true"', "android:configChanges="]) {
      expect(activityTag).toContain(attr)
    }
    // 除了新增的这一行，别的一个字符都没动
    expect(out.replace(/\n\s+android:windowSoftInputMode="adjustResize"/, "")).toBe(STOCK_MANIFEST)
  })

  it("打两次和打一次一样，不会重复加属性", () => {
    const once = patch.patchManifest(STOCK_MANIFEST)
    expect(patch.patchManifest(once)).toBe(once)
    expect(once.match(/windowSoftInputMode/g)).toHaveLength(1)
  })

  it("已经是 adjustResize（带别的标志位）就不动", () => {
    const xml = STOCK_MANIFEST.replace('android:name=".MainActivity"', 'android:name=".MainActivity" android:windowSoftInputMode="stateHidden|adjustResize"')
    expect(patch.patchManifest(xml)).toBe(xml)
  })

  it("已经声明成别的模式（比如 adjustPan）时失败，不替人做主", () => {
    const xml = STOCK_MANIFEST.replace('android:name=".MainActivity"', 'android:name=".MainActivity" android:windowSoftInputMode="adjustPan"')
    expect(() => patch.patchManifest(xml)).toThrow(/adjustPan/)
  })

  it("找不到 .MainActivity 时失败（模板变了）", () => {
    expect(() => patch.patchManifest(STOCK_MANIFEST.replace(".MainActivity", ".Other"))).toThrow(/MainActivity/)
  })

  it("别的 activity 上已有 windowSoftInputMode 不会被当成 MainActivity 的", () => {
    const withOther = STOCK_MANIFEST.replace(
      "    </application>",
      '        <activity android:name=".Other" android:windowSoftInputMode="adjustResize" />\n    </application>',
    )
    const out = patch.patchManifest(withOther)
    const mainTag = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/s.exec(out)![0]
    expect(mainTag).toContain("adjustResize")
  })
})

describe("renderMainActivity", () => {
  it("沿用原文件的包名，生成带补丁标记的 MainActivity", () => {
    const out = patch.renderMainActivity(STOCK_ACTIVITY, template)
    expect(out.startsWith("package com.lketernal.harness;")).toBe(true)
    expect(out).not.toContain("__PACKAGE__")
    expect(out).toContain(patch.MARKER)
    expect(out).toContain("public class MainActivity extends BridgeActivity")
  })

  it("包名换了也跟着换（不写死 appId）", () => {
    const out = patch.renderMainActivity(STOCK_ACTIVITY.replace("com.lketernal.harness", "com.example.other"), template)
    expect(out.startsWith("package com.example.other;")).toBe(true)
  })

  it("已经打过补丁的原样返回", () => {
    const once = patch.renderMainActivity(STOCK_ACTIVITY, template)
    expect(patch.renderMainActivity(once, template)).toBe(once)
  })

  it("MainActivity 不是模板里的空类时失败，不覆盖别人的改动", () => {
    const customized = STOCK_ACTIVITY.replace("{}", "{\n    @Override\n    public void onCreate(android.os.Bundle b) { super.onCreate(b); }\n}")
    expect(() => patch.renderMainActivity(customized, template)).toThrow(/空类/)
  })

  it("没有 package 声明时失败", () => {
    expect(() => patch.renderMainActivity("public class MainActivity extends BridgeActivity {}", template)).toThrow(/package/)
  })

  it("模板里丢了占位符时失败", () => {
    expect(() => patch.renderMainActivity(STOCK_ACTIVITY, "public class MainActivity {}")).toThrow(/__PACKAGE__/)
  })
})

describe("模板本身的约束（这些写法一变，键盘行为就变）", () => {
  it("用系统给的输入法高度，并按几何关系算让出多少，而不是直接加整个键盘高度", () => {
    expect(template).toContain("WindowInsetsCompat.Type.ime()")
    expect(template).toContain("static int imeOverlap(")
    // 实际设给内容区的 padding 必须来自 imeOverlap(内容区位置、内容区高度、窗口高度、键盘高度)，不能直接用键盘高度
    expect(template).toMatch(/overlap = imeOverlap\(location\[1\], content\.getHeight\(\), content\.getRootView\(\)\.getHeight\(\), imeBottom\);/)
    expect(template).toContain("getLocationInWindow(location)")
    expect(template).toMatch(/setPadding\([^;]*, overlap\);/)
    expect(template).not.toMatch(/setPadding\([^;]*imeBottom/)
    expect(template).not.toMatch(/overlap = imeBottom/)
  })

  it("分发 insets 时和布局完成后各算一次，并且 insets 原样继续往下传", () => {
    expect(template).toContain("setOnApplyWindowInsetsListener(content")
    expect(template).toContain("addOnGlobalLayoutListener")
    expect(template).toMatch(/return insets;/)
  })

  it("padding 没变时不重复设置，免得触发无谓的重新布局", () => {
    expect(template).toMatch(/getPaddingBottom\(\) != overlap/)
  })
})

describe("patchAndroidProject", () => {
  it("对 cap add android 同结构的工程打上补丁，两个文件都改", () => {
    const dir = makeAndroidProject()
    const changed = patch.patchAndroidProject(dir)
    expect(changed).toHaveLength(2)
    expect(manifestOf(dir)).toContain('android:windowSoftInputMode="adjustResize"')
    expect(activityOf(dir)).toContain(patch.MARKER)
  })

  it("跑第二次没有改动", () => {
    const dir = makeAndroidProject()
    patch.patchAndroidProject(dir)
    const manifest = manifestOf(dir)
    const activity = activityOf(dir)
    expect(patch.patchAndroidProject(dir)).toEqual([])
    expect(manifestOf(dir)).toBe(manifest)
    expect(activityOf(dir)).toBe(activity)
  })

  it("任何一个文件对不上，两个文件都不改", () => {
    const customized = STOCK_ACTIVITY.replace("{}", "{ int x; }")
    const dir = makeAndroidProject({ activity: customized })
    expect(() => patch.patchAndroidProject(dir)).toThrow()
    expect(manifestOf(dir)).toBe(STOCK_MANIFEST)
    expect(activityOf(dir)).toBe(customized)
  })

  it("找不到 MainActivity.java，或者找到多个，都失败", () => {
    const none = makeAndroidProject()
    fs.rmSync(path.join(none, "app", "src", "main", "java"), { recursive: true })
    fs.mkdirSync(path.join(none, "app", "src", "main", "java"))
    expect(() => patch.patchAndroidProject(none)).toThrow(/找到 0 个/)

    const two = makeAndroidProject()
    const extra = path.join(two, "app", "src", "main", "java", "com", "other")
    fs.mkdirSync(extra, { recursive: true })
    fs.writeFileSync(path.join(extra, "MainActivity.java"), STOCK_ACTIVITY)
    expect(() => patch.patchAndroidProject(two)).toThrow(/找到 2 个/)
  })

  it("目录结构不对时失败", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-ime-empty-"))
    tmpDirs.push(dir)
    expect(() => patch.patchAndroidProject(dir)).toThrow(/AndroidManifest/)
  })
})

describe("CI 工作流", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "mobile-apk.yml"), "utf8").replace(/\r\n/g, "\n")

  it("在生成安卓工程之后、编译 APK 之前运行补丁脚本", () => {
    const generate = workflow.indexOf("name: Generate Capacitor Android Project")
    const patchStep = workflow.indexOf("node scripts/patch-android-ime.cjs android")
    const build = workflow.indexOf("name: Build APK")
    expect(generate).toBeGreaterThan(-1)
    expect(patchStep).toBeGreaterThan(generate)
    expect(build).toBeGreaterThan(patchStep)
  })
})
