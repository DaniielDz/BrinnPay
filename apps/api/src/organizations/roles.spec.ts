import { can, isDownward } from './roles';

describe('roles / permission matrix (phase 4 §4.3, D2/D3)', () => {
  it('organizations.read is granted to every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(can(role, 'organizations.read')).toBe(true);
    }
  });

  it('organizations.update is owner+admin only', () => {
    expect(can('owner', 'organizations.update')).toBe(true);
    expect(can('admin', 'organizations.update')).toBe(true);
    expect(can('member', 'organizations.update')).toBe(false);
    expect(can('viewer', 'organizations.update')).toBe(false);
  });

  it('organizations.delete is owner-only', () => {
    for (const role of ['admin', 'member', 'viewer'] as const) {
      expect(can(role, 'organizations.delete')).toBe(false);
    }
    expect(can('owner', 'organizations.delete')).toBe(true);
  });

  it('members.read is granted to every role (viewer reads the roster)', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(can(role, 'members.read')).toBe(true);
    }
  });

  it('members.update and members.remove are owner+admin in the matrix (self-service handled separately)', () => {
    expect(can('owner', 'members.update')).toBe(true);
    expect(can('admin', 'members.update')).toBe(true);
    expect(can('member', 'members.update')).toBe(false);
    expect(can('viewer', 'members.update')).toBe(false);

    expect(can('owner', 'members.remove')).toBe(true);
    expect(can('admin', 'members.remove')).toBe(true);
    expect(can('member', 'members.remove')).toBe(false);
    expect(can('viewer', 'members.remove')).toBe(false);
  });

  it('invitations capabilities are owner+admin only', () => {
    for (const capability of ['invitations.read', 'invitations.create', 'invitations.cancel'] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('admin', capability)).toBe(true);
      expect(can('member', capability)).toBe(false);
      expect(can('viewer', capability)).toBe(false);
    }
  });

  it('phase 5: projects.read and apiKeys.read are granted to every role (§4.3, D3)', () => {
    for (const capability of ['projects.read', 'apiKeys.read'] as const) {
      for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
        expect(can(role, capability)).toBe(true);
      }
    }
  });

  it('phase 5: projects.create/update/delete and apiKeys.create/revoke are owner+admin only (§4.3, D3)', () => {
    for (const capability of [
      'projects.create',
      'projects.update',
      'projects.delete',
      'apiKeys.create',
      'apiKeys.revoke',
    ] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('admin', capability)).toBe(true);
      expect(can('member', capability)).toBe(false);
      expect(can('viewer', capability)).toBe(false);
    }
  });

  it('phase 6: customers.read is granted to every member role (§4.3, D5)', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(can(role, 'customers.read')).toBe(true);
    }
  });

  it('phase 6: customers.create/update/delete are owner+admin only (§4.3, D5)', () => {
    for (const capability of ['customers.create', 'customers.update', 'customers.delete'] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('admin', capability)).toBe(true);
      expect(can('member', capability)).toBe(false);
      expect(can('viewer', capability)).toBe(false);
    }
  });

  it('phase 7: payments.read is granted to every member role (§4.3, D5)', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(can(role, 'payments.read')).toBe(true);
    }
  });

  it('phase 7: payments.create is owner+admin only (§4.3, D5)', () => {
    expect(can('owner', 'payments.create')).toBe(true);
    expect(can('admin', 'payments.create')).toBe(true);
    expect(can('member', 'payments.create')).toBe(false);
    expect(can('viewer', 'payments.create')).toBe(false);
  });

  it('isDownward reflects the strict owner > admin > member > viewer ordering', () => {
    expect(isDownward('owner', 'admin')).toBe(true);
    expect(isDownward('admin', 'member')).toBe(true);
    expect(isDownward('member', 'viewer')).toBe(true);
    expect(isDownward('owner', 'viewer')).toBe(true);
    expect(isDownward('admin', 'owner')).toBe(false);
    expect(isDownward('member', 'member')).toBe(false);
    expect(isDownward('viewer', 'viewer')).toBe(false);
    expect(isDownward('viewer', 'member')).toBe(false);
  });
});