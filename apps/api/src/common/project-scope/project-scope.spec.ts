import type { ApiKeyContext } from '../../api-keys/api-key-context';
import type { AuthenticatedRequest } from '../../auth/current-user';
import type { ResolvedProject } from '../../projects/request-project';
import { resolveProjectScope } from './project-scope';

const PROJECT_ID = '0192f2a0-0000-7000-8000-00000000000b';
const ORG_ID = '0192f2a0-0000-7000-8000-00000000000a';
const USER_ID = '0192f2a0-0000-7000-8000-000000000008';

const PROJECT: ResolvedProject = { project_id: PROJECT_ID, organization_id: ORG_ID };

describe('resolveProjectScope (shared scope decorator body, phase 18 D1)', () => {
  it('returns the API-key scope attached by the guard', () => {
    const key = {
      key_id: 'key-1',
      project_id: PROJECT_ID,
      organization_id: ORG_ID,
      environment: 'test',
    } as ApiKeyContext;

    expect(resolveProjectScope({ apiKey: key } as unknown as AuthenticatedRequest)).toEqual({
      mode: 'api_key',
      key,
      project_id: PROJECT_ID,
      environment: 'test',
    });
  });

  it('returns the session scope including the resolved user (audit actor)', () => {
    const request = {
      project: PROJECT,
      authUser: { id: USER_ID },
    } as unknown as AuthenticatedRequest;

    expect(resolveProjectScope(request)).toEqual({
      mode: 'session',
      project: PROJECT,
      project_id: PROJECT_ID,
      user_id: USER_ID,
    });
  });

  it('refuses a session scope without an authenticated user (programming error)', () => {
    const request = { project: PROJECT } as unknown as AuthenticatedRequest;

    expect(() => resolveProjectScope(request)).toThrow(
      'ProjectScope used without an authenticated session user',
    );
  });

  it('refuses both scopes attached at once (programming error)', () => {
    const request = {
      apiKey: { project_id: PROJECT_ID },
      project: PROJECT,
    } as unknown as AuthenticatedRequest;

    expect(() => resolveProjectScope(request)).toThrow(
      'ProjectAccessGuard attached both API-key and session scopes',
    );
  });

  it('refuses use outside the guard (programming error)', () => {
    expect(() => resolveProjectScope({} as AuthenticatedRequest)).toThrow(
      'ProjectScope used outside the project access guard',
    );
  });
});
