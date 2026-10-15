import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { currentEmail, isAdmin, logout } from '../auth';
import { LogoMark } from './Icons';

/** account：ログイン中のメールアドレスとログアウト（勉強中の画面では出さない） */
export function Header({ right, account = true }: { right?: ReactNode; account?: boolean }) {
  return (
    <header className="top">
      <div className="brand">
        <LogoMark />
        <div className="brand-name">家トモ</div>
      </div>
      <nav className="nav" aria-label="メイン">
        <NavLink to="/" end>はじめる</NavLink>
        <NavLink to="/settings">設定</NavLink>
        {isAdmin() && <NavLink to="/admin">管理者設定</NavLink>}
      </nav>
      <div className="spacer" />
      {right}
      {account && (
        <div className="header-user">
          <span>{currentEmail()}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => logout()}>ログアウト</button>
        </div>
      )}
    </header>
  );
}
