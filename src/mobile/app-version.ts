/**
 * 当前这份手机端网页包的版本，打包时由 vite.mobile.config.ts 从 package.json 注入。
 * APK 里的网页包是安装时的快照，所以它代表「这个 App 是哪一版」。
 * 测试或没注入时落到 0.0.0（比任何发布版都旧）。
 */
declare const __APP_VERSION__: string | undefined

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "0.0.0"
