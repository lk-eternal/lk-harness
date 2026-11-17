import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { installDprAnimationRestart } from "./dpr-animation-restart"
import "./index.css"

// 缩放/DPI 变化后转圈偶发偏心（合成层没跟上），变化时把动画重启一遍
installDprAnimationRestart()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
