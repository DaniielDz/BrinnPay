import Link from 'next/link';

const DASHBOARD_NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/organizations', label: 'Organizations' },
  { href: '/dashboard/projects', label: 'Projects' },
  { href: '/dashboard/settings', label: 'Settings' },
];

/**
 * Authenticated area layout (phase 1 §11.4). Minimal dashboard shell with
 * static navigation only. Route protection is NOT implemented in Phase 2
 * (phase 2 §5.2): no redirect logic, no session access, no middleware that
 * touches tokens.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
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
      <main>{children}</main>
    </div>
  );
}