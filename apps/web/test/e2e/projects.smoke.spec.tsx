import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../components/auth/auth-provider';
import ProjectsPage from '../../app/(dashboard)/dashboard/projects/page';
import ProjectApiKeysPage from '../../app/(dashboard)/dashboard/projects/[projectId]/api-keys/page';
import {
  createdKeyFixture,
  projectFixture,
  stubProjectsApi,
  unstubProjectsApi,
} from '../unit/projects-test-utils';

const { paramsMock } = vi.hoisted(() => ({ paramsMock: vi.fn() }));
const { searchParamsMock } = vi.hoisted(() => ({ searchParamsMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => paramsMock(),
  useSearchParams: () => searchParamsMock(),
}));

/**
 * Phase 5 e2e (spec §9.1): extends the established smoke pattern with the
 * scripted one-user project flow — list loads after login showing the owning
 * organization, API-key create reveals the plaintext once, and revoke marks
 * the key revoked. Full browser e2e and multi-tenant flows are covered at the
 * API e2e level (browser tooling remains a Phase 17 concern).
 */
describe('projects smoke test (phase 5 §5.1/§5.2)', () => {
  afterEach(() => {
    unstubProjectsApi();
    paramsMock.mockClear();
    searchParamsMock.mockClear();
  });

  it('loads the project list after login with the owning organization and env badges', async () => {
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectsPage />
      </AuthProvider>,
    );

    expect(await screen.findByRole('link', { name: /Payments API/ })).toBeInTheDocument();
    await screen.findByText('TEST');
    await screen.findByText('LIVE');
    // Owning organization appears on the row and as the create-form selector.
    expect(screen.getAllByText('Acme Sandbox').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/members?limit=100'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }) }),
    );
  });

  it('scripted one-user flow: create a key once, copy, revoke (D5/D4)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    searchParamsMock.mockReturnValue(new URLSearchParams());
    paramsMock.mockReturnValue({ projectId: projectFixture.id });
    const { fetchMock } = stubProjectsApi();
    render(
      <AuthProvider>
        <ProjectApiKeysPage />
      </AuthProvider>,
    );

    await screen.findByRole('heading', { level: 1, name: 'API keys' });

    // Creation is offered to owner/admin; wait for the form (the heading also
    // renders during the loading state).
    await screen.findByRole('button', { name: 'Create key' });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    const revealed = createdKeyFixture('test');
    expect(await screen.findByText(revealed.key)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/api/v1/projects/${projectFixture.id}/api-keys`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ environment: 'test' }) }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    // The freshly created key ('key-new', fixture response) is prepended to the
    // list, so it is the first of the two active Revoke buttons.
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/api/v1/projects/${projectFixture.id}/api-keys/key-new`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(
        screen
          .getAllByText(/revoked/)
          .some((node) => node.textContent?.includes('key-new') ?? false),
      ).toBe(true);
    });
    confirmSpy.mockRestore();
  });
});