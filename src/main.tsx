/**
 * 前端入口
 *
 * 只做一件事：把 <App /> 挂到 index.html 的 #root 上。
 * 业务逻辑不写在这里。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
