'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '../auth/auth-provider';
import { SignOutButton } from '../auth/sign-out-button';
import { RateLimitIndicator } from './rate-limit-indicator';

const DASHBOARD_NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/organizations', label: 'Organizations' },
  { href: '/dashboard/projects', label: 'Projects' },
  { href: '/dashboard/settings', label: 'Settings' },
];

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The single dashboard shell (phase 14 §6.1): global navigation with a visible
 * current-location state, the signed-in identity and the `SignOutButton` in the
 * header, the rate-limit budget indicator (§7.4), and a responsive navigation
 * disclosure (§7.1) that keeps the nav reachable at small widths via a button
 * with `aria-expanded`. Project-scoped child links stay in the project shell
 * (phase 5 §5.3) — never duplicated here.
 *
 * It only renders inside `AuthGuard` (phase 3 §4.4), so there is no shell flash
 * for unauthenticated visitors; the API remains the enforcement point.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/dashboard';
  const { user } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  const identity = user?.name?.trim() ? user.name : (user?.email ?? '');

  return (
    <div className="dashboard-shell">
      <header className="dashboard-topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={navOpen}
          aria-controls="dashboard-navigation"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span aria-hidden="true">☰ </span>Menu
        </button>
        <Link href="/dashboard" className="dashboard-brand">
          BrinnPay
        </Link>
        <div className="dashboard-header-actions">
          <RateLimitIndicator />
          {user ? (
            <span className="dashboard-identity">
              <span className="identity-name">{identity}</span>
              {user.name?.trim() && user.name.trim() !== user.email ? (
                <span className="identity-email">{user.email}</span>
              ) : null}
            </span>
          ) : null}
          <SignOutButton />
        </div>
      </header>

      <div className="dashboard-body">
        <aside className={`dashboard-sidebar${navOpen ? ' is-open' : ''}`}>
          <nav id="dashboard-navigation" aria-label="Dashboard">
            <ul>
              {DASHBOARD_NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActivePath(pathname, item.href) ? 'page' : undefined}
                    onClick={() => setNavOpen(false)}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <main className="dashboard-main">{children}</main>
      </div>
    </div>
  );
}
