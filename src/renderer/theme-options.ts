import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"

export type Theme = AppConfig["theme"]

export const THEME_OPTIONS: { v: Theme; label: string; icon: LucideIcon }[] = [
  { v: "system", label: "跟随系统", icon: Monitor },
  { v: "light", label: "浅色", icon: Sun },
  { v: "dark", label: "深色", icon: Moon },
]
