import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProjectCustomersPage from '../../app/(dashboard)/dashboard/projects/[projectId]/customers/page';
import ProjectLogsAuditPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/audit/page';
import ProjectLogsRequestsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/logs/requests/page';
import ProjectPaymentsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/payments/page';
import ProjectRefundsPage from '../../app/(dashboard)/dashboard/projects/[projectId]/refunds/page';
import ProjectWebhooksPage from '../../app/(dashboard)/dashboard/projects/[projectId]/webhooks/page';

describe('project route skeleton (phase 2 §5.2)', () => {
  // `projects/[projectId]` and `projects/[projectId]/api-keys` are data-driven
  // since Phase 5 (project shell + API-key management); the remaining
  // environment-scoped child routes keep their placeholders until their
  // owning phases (6+).
  const cases = [
    { Component: ProjectCustomersPage, heading: 'Customers' },
    { Component: ProjectPaymentsPage, heading: 'Payments' },
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