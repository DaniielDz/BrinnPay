import Link from 'next/link';

import { AuthGuard } from '../../components/auth/auth-guard';
import { SignOutButton } from '../../components/auth/sign-out-button';

const DASHBOARD_NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/organizations', label: 'Organizations' },
  { href: '/dashboard/projects', label: 'Projects' },
  { href: '/dashboard/settings', label: 'Settings' },
];

/**
 * Authenticated area layout (phase 1 §11.4). Route protection is enforced
 * client-side by `AuthGuard` (phase 3 §4.4); the API remains the enforcement
 * point for every authenticated request.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="dashboard-shell">
        <aside>
          <nav aria-label="Dashboard">
            <ul>
              {DASHBOARD_NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <main>
          <header className="dashboard-header">
            <SignOutButton />
          </header>
          {children}
        </main>
      </div>
    </AuthGuard>
  );
}