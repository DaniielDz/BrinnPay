import Link from 'next/link';

/**
 * Public area layout (phase 1 §11.1, phase 14 §4.2): static content, no
 * authenticated material, no data fetching (phase 2 §5.2).
 *
 * Navigation exposes Home, Product and Docs plus the authentication CTAs
 * (Log in / Get started); the footer carries the product identity, the same
 * links and the plain sandbox statement. The shell contains no session-aware
 * material regardless of sign-in state (phase 14 D9).
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-layout">
      <header className="public-header">
        <Link href="/" className="brand">
          BrinnPay
        </Link>
        <nav aria-label="Public">
          <ul className="public-nav">
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
          <ul className="public-nav-auth">
            <li>
              <Link href="/login">Log in</Link>
            </li>
            <li>
              <Link href="/register" className="button button-primary">
                Get started
              </Link>
            </li>
          </ul>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="public-footer">
        <p className="footer-identity">
          BrinnPay — payment infrastructure sandbox for developers.
        </p>
        <nav aria-label="Footer">
          <ul>
            <li>
              <Link href="/product">Product</Link>
            </li>
            <li>
              <Link href="/docs">Docs</Link>
            </li>
            <li>
              <Link href="/login">Login</Link>
            </li>
          </ul>
        </nav>
        <p className="footer-sandbox">
          BrinnPay is a sandbox: it processes no real money.
        </p>
      </footer>
    </div>
  );
}
