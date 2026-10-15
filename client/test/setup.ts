import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// ログイン（Firebase）は使わない。サーバーに付けるトークンは固定
vi.mock('../src/auth', () => ({
  authHeader: async () => ({ Authorization: 'Bearer test' }),
  authQuery: () => 'token=test',
  isAdmin: () => false,
  currentEmail: () => '',
  login: vi.fn(),
  logout: vi.fn(),
  onUser: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

// jsdom にないもの（studyTime.ts が読み込み時に使う）
if (!performance.getEntriesByType) Object.assign(performance, { getEntriesByType: () => [] });
