import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Surface runtime crashes on-screen instead of a silent black page.
function showFatal(msg: string): void {
  let el = document.getElementById('fatal-overlay')
  if (!el) {
    el = document.createElement('div')
    el.id = 'fatal-overlay'
    el.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(20,0,10,0.95);color:#ff6b8a;' +
      'font:14px/1.7 monospace;padding:28px;overflow:auto;white-space:pre-wrap;'
    document.body.appendChild(el)
  }
  el.textContent = 'NEON HARBOR hit a problem:\n\n' + msg + '\n\nPlease copy this message and send it back.'
}
window.addEventListener('error', (e) => showFatal(`${e.message}\n${(e.filename ?? '').split('/').pop()}:${e.lineno ?? ''}`))
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason)))

createRoot(document.getElementById('root')!).render(<App />)
