import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';
import ProjectLogsRequestsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/requests/page';
import ProjectRefundsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/refunds/page';
import ProjectWebhooksPage from '../../app/(dashboard)/dashboard/projects/[projectId]/webhooks/page';

describe('project route skeleton (phase 2 §5.2)', () => {
  // `projects/[projectId]`, `projects/[projectId]/api-keys` (Phase 5),
  // `projects/[projectId]/customers` (Phase 6) and
  // `projects/[projectId]/payments` (Phase 7) are data-driven; the remaining
  // environment-scoped child routes keep their placeholders until their
  // owning phases (8+).
  const cases = [
    { Component: ProjectRefundsPage, heading: 'Refunds' },
    { Component: ProjectWebhooksPage, heading: 'Webhooks' },
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