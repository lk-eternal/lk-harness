/** 内置大模型提供商（Setup / Agent 页下拉用 providerId 标识） */
export interface BuiltinLlmProvider {
  id: string
  label: string
}

export const BUILTIN_LLM_PROVIDERS: BuiltinLlmProvider[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "google", label: "Google Gemini" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "xai", label: "xAI" },
  { id: "openrouter", label: "OpenRouter" },
]

export const LLM_API_PROTOCOLS = [
  { id: "openai-completions", label: "OpenAI 兼容（Completions）" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
] as const

export type LlmApiProtocol = (typeof LLM_API_PROTOCOLS)[number]["id"]

export function builtinProviderLabel(providerId: string | undefined): string {
  if (!providerId) return "未知"
  return BUILTIN_LLM_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId
}
