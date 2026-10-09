import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AcceptInvitationPage from '../../app/(dashboard)/dashboard/invitations/[invitationId]/page';
import { AuthProvider } from '../../components/auth/auth-provider';
import { orgFixture, stubOrganizationsApi, unstubOrganizationsApi } from '../unit/organizations-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => paramsMock(),
  useRouter: () => ({ replace: vi.fn() }),
}));

/**
 * Phase 4 flow at smoke level (established jsdom pattern): the invited user
 * reaches the accept flow from its URL, accepts under the restored session,
 * and lands on links into the organization. Error-state mappings live in
 * `organizations-pages.spec.tsx`; real browsers are Phase 17 D1.
 */
describe('invitations smoke test (phase 4 §5.2)', () => {
  afterEach(() => {
    unstubOrganizationsApi();
    paramsMock.mockClear();
  });

  it('accepts an invitation from its URL and links into the organization', async () => {
    paramsMock.mockReturnValue({ invitationId: 'inv-1' });
    const { fetchMock } = stubOrganizationsApi();
    render(
      <AuthProvider>
        <AcceptInvitationPage />
      </AuthProvider>,
    );

    // The invited user lands on the pending flow.
    await screen.findByRole('heading', { level: 1, name: 'Accept invitation' });

    // Scripted accept → POST with the session bearer → success with links.
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' });
    expect(screen.getByRole('link', { name: 'Open the organization' })).toHaveAttribute(
      'href',
      `/dashboard/organizations/${orgFixture.id}`,
    );
    expect(screen.getByRole('link', { name: 'Back to organizations' })).toHaveAttribute(
      'href',
      '/dashboard/organizations',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/invitations/inv-1/accept',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );
  });
});
