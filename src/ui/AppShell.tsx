/**
 * AppShell —— 页面外壳：左侧导航 + 主内容区
 *
 * 为什么要单独拆：侧栏的导航项、版本号、主题切换和业务数据毫无关系，
 * 却一直和排期逻辑搅在同一个文件里。拆出来后 App.tsx 只关心
 * 「当前显示哪个页面、给它喂什么数据」，外壳换成什么样都不影响业务。
 *
 * 本组件不持有任何业务状态：导航选中项和主题都由外部传入。
 */

import type { ReactNode } from 'react';
import type { ThemeMode } from './theme';

export type View = 'board' | 'settings';

export interface NavItem {
  id: View;
  label: string;
  hint: string;
}

interface AppShellProps {
  view: View;
  onViewChange: (view: View) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  navItems: NavItem[];
  version: string;
  children: ReactNode;
}

function NavIcon({ view }: { view: View }) {
  if (view === 'board') {
    return (
      <svg
        className="h-4 w-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18M9 10v10" />
      </svg>
    );
  }
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function AppShell({
  view,
  onViewChange,
  theme,
  onToggleTheme,
  navItems,
  version,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="w-full shrink-0 border-b border-[var(--color-border)] bg-[var(--color-card)] md:min-h-screen md:w-48 md:border-b-0 md:border-r">
        <div className="px-5 py-6">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-text)]">知序</h1>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">个人事务操作系统</p>
          <p className="mt-2 inline-block rounded bg-[var(--color-card-muted)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)]">
            {version}
          </p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {navItems.map((item: NavItem) => {
            const active: boolean = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onViewChange(item.id)}
                className={`flex flex-1 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-left transition md:flex-none ${
                  active
                    ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-card-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                <NavIcon view={item.id} />
                <span className="text-sm">{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="hidden px-3 pb-4 md:block">
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
            {theme === 'dark' ? '切换浅色' : '切换深色'}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-5 md:py-6 lg:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">{children}</div>
      </main>
    </div>
  );
}
