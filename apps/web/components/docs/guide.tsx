import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

/**
 * Guide shell (phase 15 §5.1 rule 2): every guide carries its title, a lead,
 * the canonical artifact(s) it derives from, and a link back to the index
 * (§4.2). Sections inside the body are plain `<section>` elements with an
 * `<h2>`, so the heading order stays h1 → h2 → h3 on every page.
 */
export interface GuideProps {
  /** Guide title — the page's only `<h1>`. */
  title: string;
  /** One-paragraph lead under the title. */
  lead: string;
  /** Canonical artifacts the content derives from, shown as a source note. */
  sources: readonly string[];
  children: ReactNode;
}

export function Guide({ title, lead, sources, children }: GuideProps): ReactElement {
  return (
    <div className="public-page docs-page docs-guide">
      <article>
        <header className="docs-guide-header">
          <h1>{title}</h1>
          <p className="hero-lead">{lead}</p>
          <p className="docs-source">
            <strong>Derived from: </strong>
            {sources.map((source, index) => (
              <span key={source}>
                <code>{source}</code>
                {index < sources.length - 1 ? ' · ' : ''}
              </span>
            ))}
          </p>
        </header>

        {children}

        <nav className="docs-guide-footer" aria-label="Guide footer">
          <Link href="/docs">Back to the documentation index</Link>
        </nav>
      </article>
    </div>
  );
}
