import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const TEMPLATE_REL = path.join("html", "diff-template.html")

export function resolveDiffTemplatePath(): string {
  const override = process.env.LK_HARNESS_DIFF_TEMPLATE
  if (override && fs.existsSync(override)) return override
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(process.cwd(), "resources", "template", TEMPLATE_REL),
    path.resolve(moduleDir, "..", "..", "resources", "template", TEMPLATE_REL),
    path.resolve(moduleDir, "..", "template", TEMPLATE_REL),
    path.resolve(moduleDir, "../../resources/template", TEMPLATE_REL),
    path.resolve(moduleDir, "../../../resources/template", TEMPLATE_REL),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`模板缺失: ${TEMPLATE_REL}（cwd=${process.cwd()}）`)
}

export function resolveDiffTemplateDir(): string {
  return path.dirname(resolveDiffTemplatePath())
}
