'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

import { DOCS_INDEX_HREF, DOCS_SECTIONS } from '../../lib/docs/sections';

/**
 * Persistent documentation section navigation (phase 15 §4.2, AC3).
 *
 * Client-side only because the current location comes from the router; every
 * link is a plain Next.js link and the current page is exposed through
 * `aria-current="page"` so the indication is available to assistive
 * technology as well as visually.
 */
export function DocsNav(): ReactElement {
  const pathname = (usePathname() ?? '').replace(/\/+$/, '') || DOCS_INDEX_HREF;
  const onIndex = pathname === DOCS_INDEX_HREF;

  return (
    <nav className="docs-nav" aria-label="Documentation">
      <ul>
        <li className={onIndex ? 'docs-nav-index docs-nav-current' : 'docs-nav-index'}>
          <Link href={DOCS_INDEX_HREF} aria-current={onIndex ? 'page' : undefined}>
            All documentation
          </Link>
        </li>
        {DOCS_SECTIONS.map((section) => {
          const current = pathname === section.href;
          return (
            <li key={section.href} className={current ? 'docs-nav-current' : undefined}>
              <Link href={section.href} aria-current={current ? 'page' : undefined}>
                {section.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
