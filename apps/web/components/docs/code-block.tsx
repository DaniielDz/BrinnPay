import type { ReactElement } from 'react';

/**
 * Code example primitives (phase 15 §7, §9.4).
 *
 * Every example is plain text rendered through React (no
 * `dangerouslySetInnerHTML`), and each block scrolls inside its own focusable
 * region so the page itself never scrolls horizontally (§4.2, §11.5).
 */

/** One language variant of a flow (cURL, JavaScript, Python, JSON, text). */
export interface CodeExample {
  /** Human label shown above the block, e.g. `cURL` or `JavaScript (fetch)`. */
  label: string;
  /** Language token used for the code element's class. */
  language: string;
  /** The example itself. */
  code: string;
}

/**
 * A single example block. The `<pre>` is a labelled, keyboard-focusable
 * region: a scrollable element must be reachable and scrollable by keyboard.
 */
export function CodeBlock({ label, language, code }: CodeExample): ReactElement {
  const caption = label || language;
  return (
    <figure className="docs-code">
      <figcaption>{caption}</figcaption>
      <pre tabIndex={0} role="region" aria-label={`${caption} example`}>
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </figure>
  );
}

/** The same flow in more than one language (D3: cURL, JavaScript, Python). */
export function CodeExampleList({ examples }: { examples: readonly CodeExample[] }): ReactElement {
  return (
    <div className="docs-code-list">
      {examples.map((example, index) => (
        <CodeBlock
          key={`${index}-${example.language}-${example.label}`}
          label={example.label}
          language={example.language}
          code={example.code}
        />
      ))}
    </div>
  );
}
