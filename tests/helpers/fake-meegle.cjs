#!/usr/bin/env node
/**
 * 假的飞书项目 CLI（meegle），端到端测试用：daemon 通过 MEEGLE_CLI_PATH 指向它，像调真 CLI 一样调它。
 * 数据来自环境变量 FAKE_MEEGLE_DATA 指向的 JSON 文件（测试里随时改，下一次调用就读到新的）：
 *   { authenticated: boolean, failQuery?: boolean,
 *     stories: { [storyId]: storyName },
 *     bugs: { [storyName]: Array<{ id, name, status, assignee?, priority? }> } }
 * 每次调用往 FAKE_MEEGLE_LOG 追加一行参数，测试据此断言「调没调、调了几次」。
 * 返回结构照真实的 `meegle workitem query -o json`（moql_field_list）。
 */
const fs = require("fs")

const args = process.argv.slice(2)
const dataFile = process.env.FAKE_MEEGLE_DATA
const logFile = process.env.FAKE_MEEGLE_LOG
if (logFile) fs.appendFileSync(logFile, JSON.stringify(args) + "\n")
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : {}

const out = (obj) => process.stdout.write(JSON.stringify(obj))
const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1) }
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }

if (args[0] === "version") { process.stdout.write("fake-meegle 0.0.0\n"); process.exit(0) }
if (args[0] === "auth" && args[1] === "status") { out({ authenticated: data.authenticated !== false }); process.exit(0) }

if (args[0] === "workitem" && args[1] === "get") {
  const name = (data.stories || {})[arg("--work-item-id")]
  if (!name) fail("work item not found")
  out({ work_item_attribute: { work_item_name: name }, work_item_fields: [] })
  process.exit(0)
}

if (args[0] === "workitem" && args[1] === "query") {
  if (data.failQuery) fail("query failed: permission denied")
  const mql = JSON.parse(arg("-P")).mql
  const m = /array_contains\(`关联产品需求`, '([^']*)'\)/.exec(mql)
  if (!m) fail("unsupported mql: " + mql)
  const rows = ((data.bugs || {})[m[1]] || []).map((b) => ({
    moql_field_list: [
      { key: "work_item_id", value_type: "long_value", value: { long_value: Number(b.id) } },
      { key: "name", value_type: "string_value", value: { string_value: b.name } },
      { key: "work_item_status", value_type: "key_label_value", value: { key_label_value: { key: "s", label: b.status || "OPEN" } } },
      ...(b.assignee ? [{ key: "current_status_operator", value_type: "user_value_list", value: { user_value_list: [{ name_cn: b.assignee }] } }] : []),
      ...(b.priority ? [{ key: "priority", value_type: "key_label_value_list", value: { key_label_value_list: [{ key: "p", label: b.priority }] } }] : []),
    ],
  }))
  out({ data: { "1": rows } })
  process.exit(0)
}

fail("unsupported command: " + args.join(" "))
