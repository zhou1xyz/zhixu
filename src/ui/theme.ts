/**
 * 深浅色主题
 *
 * 主题存在 localStorage，刷新后保持。
 * 首次打开跟随系统设置（prefers-color-scheme）。
 * 实际生效方式：给 <html> 加 data-theme="dark"，CSS 变量随之切换。
 */
export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'zhixu-theme';

export function readStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
  } catch {
    /* 隐私模式下可能取不到，忽略 */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 存不了也不影响当前会话 */
  }
}
