import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';
import ProjectLogsRequestsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/requests/page';

describe('project route skeleton (phase 2 §5.2)', () => {
  // `projects/[projectId]`, `projects/[projectId]/api-keys` (Phase 5),
  // `projects/[projectId]/customers` (Phase 6) and
  // `projects/[projectId]/payments` (Phase 7) and refunds (Phase 9) are data-driven; the remaining
  // environment-scoped child routes keep their placeholders until their
  // owning phases (12+). `webhooks` is data-driven as of Phase 10 §7 and is
  // covered by `webhooks-pages.spec.tsx`.
  const cases = [
    { Component: ProjectLogsRequestsPage, heading: 'Request logs' },
    { Component: ProjectLogsAuditPage, heading: 'Audit logs' },
  ];

  it.each(cases)('renders the $heading placeholder with static content', ({ Component, heading }) => {
    render(<Component />);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    // No data fetching, no business behavior, no sensitive material.
    expect(screen.queryByText(/sk_live_/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk_test_/i)).not.toBeInTheDocument();
  });
});
