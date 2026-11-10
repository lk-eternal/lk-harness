// mammoth 的浏览器版本（自带打包好的单文件，不依赖 Node 内置模块），包里没有它的类型声明
declare module "mammoth/mammoth.browser" {
  interface ConvertResult {
    value: string
    messages: { type: string; message: string }[]
  }
  interface Mammoth {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>
  }
  const mammoth: Mammoth
  export default mammoth
}
