import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home';
import { Study } from './pages/Study';
import { DebugLesson } from './pages/DebugLesson';
import { Settings } from './pages/Settings';
import { AdminSettings } from './pages/AdminSettings';
import { Pad } from './pages/Pad';
import { LoginGate } from './components/LoginGate';
import { isAdmin } from './auth';
import './styles.css';

// ログインしたあとの画面。コンポーネントにして、ログインしてから描く（isAdmin がログイン後の値になるように）
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/study/:id" element={<Study />} />
      <Route path="/settings" element={<Settings />} />
      {/* 管理者設定・デバッグ授業は管理者だけ（サーバーも 403 で断る） */}
      {isAdmin() && <Route path="/study/:id/debug" element={<DebugLesson />} />}
      {isAdmin() && <Route path="/admin" element={<AdminSettings />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* iPad のノート：iPad の Safari で開く手書きのページ（学習画面の QR コードから）。AI を使わないのでログインはいらない */}
        <Route path="/pad/:room" element={<Pad />} />
        <Route path="*" element={
          <LoginGate>
            <AppRoutes />
          </LoginGate>
        } />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
