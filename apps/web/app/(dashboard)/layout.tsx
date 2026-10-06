import { AuthGuard } from '../../components/auth/auth-guard';
import { DashboardShell } from '../../components/dashboard/dashboard-shell';

/**
 * Authenticated area layout (phase 1 §11.4). Route protection is enforced
 * client-side by `AuthGuard` (phase 3 §4.4, phase 14 §7.2/D5): the shell —
 * navigation, identity, sign-out, rate-limit indicator — renders only once a
 * session exists, so unauthenticated visitors never see it. The API remains
 * the enforcement point for every authenticated request.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <DashboardShell>{children}</DashboardShell>
    </AuthGuard>
  );
}
