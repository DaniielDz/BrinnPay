import Link from 'next/link';

/**
 * Public area layout (phase 1 §11.1). Placeholder shell only: static content,
 * no authenticated material, no data fetching (phase 2 §5.2).
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-layout">
      <header>
        <nav aria-label="Public">
          <Link href="/">Home</Link>
          <Link href="/product">Product</Link>
          <Link href="/docs">Docs</Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer>BrinnPay — payment infrastructure sandbox for developers.</footer>
    </div>
  );
}