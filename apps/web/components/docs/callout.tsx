import type { ReactElement, ReactNode } from 'react';

/**
 * Callouts (phase 15 §9.4): a labelled aside for the notes that must not read
 * as body prose — simulation honesty, placeholder warnings, and the "current
 * behavior only" boundary. Content is always React children, so it is escaped
 * by the renderer (§11.5).
 */

export type CalloutTone = 'note' | 'important' | 'warning';

export interface CalloutProps {
  /** Short label, e.g. `Sandbox` or `Placeholder values`. */
  title: string;
  /** `warning` is reserved for the honesty/security boundaries. */
  tone?: CalloutTone;
  children: ReactNode;
}

export function Callout({ title, tone = 'note', children }: CalloutProps): ReactElement {
  return (
    <aside className={`docs-callout docs-callout-${tone}`}>
      <p className="docs-callout-title">{title}</p>
      <div className="docs-callout-body">{children}</div>
    </aside>
  );
}
