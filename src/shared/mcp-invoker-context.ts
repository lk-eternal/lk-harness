import { AsyncLocalStorage } from "node:async_hooks";

const invokerSessionKeyStore = new AsyncLocalStorage<string | undefined>();

export function runWithMcpInvokerSessionKey<T>(sessionKey: string | undefined, fn: () => T): T {
  return invokerSessionKeyStore.run(sessionKey?.trim() || undefined, fn);
}

export function getMcpInvokerSessionKey(): string | undefined {
  return invokerSessionKeyStore.getStore();
}
