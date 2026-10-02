import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';

describe('project route skeleton (phase 2 §5.2)', () => {
  // `projects/[projectId]`, `projects/[projectId]/api-keys` (Phase 5),
  // `projects/[projectId]/customers` (Phase 6), `projects/[projectId]/payments` (Phase 7),
  // refunds (Phase 9), `webhooks` (Phase 10 §7) and
  // `projects/[projectId]/logs/requests` (Phase 11 §7) are data-driven; the remaining
  // environment-scoped child route keeps its placeholder until its
  // owning phase (12+). The request-log viewer is covered by
  // `request-logs-pages.spec.tsx`.
  it('renders the audit placeholder with static content', () => {
    render(<ProjectLogsAuditPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Audit logs' })).toBeInTheDocument();
    // No data fetching, no business behavior, no sensitive material.
    expect(screen.queryByText(/sk_live_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk_test_/i)).not.toBeInTheDocument();
  });
});
