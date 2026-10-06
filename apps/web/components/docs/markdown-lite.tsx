import type { ReactElement, ReactNode } from 'react';

/**
 * Minimal, safe Markdown renderer for text authored in the canonical contract
 * (phase 15 §11.5).
 *
 * The OpenAPI descriptions contain a small Markdown subset — paragraphs,
 * bullet lists, inline `code` and `**bold**`. Rendering it as React elements
 * (never `dangerouslySetInnerHTML`) keeps the browser as the only HTML
 * parser, so a contract file cannot introduce an injection path into the
 * page.
 */

const INLINE_TOKENS = /(`[^`]+`|\*\*[^*]+\*\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(INLINE_TOKENS);

  parts.forEach((part, index) => {
    if (part === '') return;
    const key = `${keyPrefix}-${index}`;

    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>);
      return;
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>);
      return;
    }

    // Single newlines inside a paragraph become line breaks; the paragraph
    // structure itself is decided by the blank-line split.
    const lines = part.split('\n');
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) nodes.push(<br key={`${key}-br-${lineIndex}`} />);
      if (line) nodes.push(<span key={`${key}-t-${lineIndex}`}>{line}</span>);
    });
  });

  return nodes;
}

function isListItem(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

/**
 * Renders the contract's Markdown subset. Unknown syntax is shown literally,
 * which is always safe and never silently dropped.
 */
export function MarkdownLite({
  text,
  className,
}: {
  text: string;
  className?: string;
}): ReactElement | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const blocks = trimmed.split(/\n[ \t]*\n/);

  return (
    <div className={className ? `docs-markdown ${className}` : 'docs-markdown'}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').filter((line) => line.trim() !== '');

        if (lines.length > 0 && lines.every((line) => isListItem(line))) {
          return (
            <ul key={blockIndex}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{renderInline(line.replace(/^\s*[-*]\s+/, ''), `${blockIndex}-${lineIndex}`)}</li>
              ))}
            </ul>
          );
        }

        return <p key={blockIndex}>{renderInline(lines.join('\n'), `p${blockIndex}`)}</p>;
      })}
    </div>
  );
}
