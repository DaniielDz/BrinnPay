import Link from 'next/link';

/**
 * Authentication area layout (phase 1 §11.2/§11.3, phase 14 §5): the auth pages
 * render inside the same branding and navigation as the public shell, with no
 * behavioral change to the Phase 3 flows. No session material, cookie names or
 * tokens appear in the rendered output (phase 3 §9).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <Link href="/" className="brand">
          BrinnPay
        </Link>
        <nav aria-label="Authentication">
          <ul>
            <li>
              <Link href="/">Home</Link>
            </li>
            <li>
              <Link href="/product">Product</Link>
            </li>
            <li>
              <Link href="/docs">Docs</Link>
            </li>
          </ul>
        </nav>
      </header>
      <main className="auth-main">{children}</main>
      <footer className="auth-footer">
        <p>BrinnPay is a sandbox that processes no real money.</p>
      </footer>
    </div>
  );
}
