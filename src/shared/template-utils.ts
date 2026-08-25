import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function getTemplateRoot(): string {
  const envRoot = process.env.LK_HARNESS_TEMPLATE_DIR ?? process.env.CURSOR_CLAW_TEMPLATE_DIR;
  if (envRoot) {
    return envRoot;
  }

  const candidates = [
    path.resolve(process.cwd(), "resources", "template"),
    path.resolve(moduleDir, "../../resources/template"),
    path.resolve(moduleDir, "../../../resources/template"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function readTemplate(relativePath: string): string {
  const fullPath = path.join(getTemplateRoot(), relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`模板文件不存在: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, "utf-8");
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
