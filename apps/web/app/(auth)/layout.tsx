import Link from 'next/link';

/**
 * Authentication area layout (phase 1 §11.3). Placeholder shell only: no login
 * or registration behavior in Phase 2 (phase 2 §5.2).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-layout">
      <header>
        <nav aria-label="Authentication">
          <Link href="/login">Log in</Link>
          <Link href="/register">Register</Link>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}