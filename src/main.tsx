import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TitleBar } from './components/TitleBar.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Custom riso title bar (Tauri only) sits above the app. TitleBar renders
        null in the browser, so the app fills the full height there. */}
    <div className="flex flex-col h-screen overflow-hidden bg-surface-0">
      <TitleBar />
      <div className="flex-1 min-h-0">
        <App />
      </div>
    </div>
  </StrictMode>,
)
