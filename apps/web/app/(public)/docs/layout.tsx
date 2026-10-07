import { DocsNav } from '../../../components/docs/docs-nav';

/**
 * Documentation area layout (phase 15 §4.2): the public shell plus the
 * persistent section navigation that identifies the current location. The
 * navigation is a client component (it reads the pathname); everything else
 * in the docs area stays server-rendered and static, with no API calls.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-layout">
      <DocsNav />
      <div className="docs-content">{children}</div>
    </div>
  );
}
