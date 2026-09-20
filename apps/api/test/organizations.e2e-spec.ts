import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Phase 4 e2e (§9): organizations CRUD, RBAC member management, and the
 * invitation lifecycle against the running Nest application with real
 * PostgreSQL/Redis. CI provides dependencies as service containers; locally
 * the suite is skipped when they are unreachable (same pattern as Phase 3).
 */
const RUN = Date.now().toString(36);
const EMAIL = (slug: string) => `e2e-org-${slug}-${RUN}@example.com`;
const PASSWORD = 'password-123';

interface Reachable {
  value: boolean;
}

describe('BrinnPay organizations (e2e, phase 4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const reachable: Reachable = { value: false };

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService));
    await app.init();

    prisma = app.get(PrismaService);
    const redis = app.get(RedisService);
    try {
      await prisma.ping();
      await redis.ping();
      reachable.value = true;
    } catch {
      // Dependencies unavailable (local run without docker compose).
    }

    if (reachable.value) {
      await prisma.invitation.deleteMany();
      await prisma.organizationMember.deleteMany();
      await prisma.organization.deleteMany();
      await prisma.refreshSession.deleteMany();
      await prisma.user.deleteMany();
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Registers a fresh account and returns its access token + public user. */
  const register = async (slug: string) => {
    const response = await request(server())
      .post('/api/v1/auth/register')
      .send({ email: EMAIL(slug), password: PASSWORD, name: `Org E2E ${slug}` });
    expect(response.status).toBe(201);
    return {
      token: response.body.access_token as string,
      user: response.body.user as { id: string; email: string },
    };
  };

  /** Session-authenticated request helper with the access token. */
  const auth = (token: string) => request(server()).set('Authorization', `Bearer ${token}`);

  /** Creates an organization for the caller; returns the organization id. */
  const createOrg = async (token: string, name: string) => {
    const response = await auth(token).post('/api/v1/organizations').send({ name });
    expect(response.status).toBe(201);
    return response.body as { id: string; name: string; created_at: string; updated_at: string };
  };

  /** Invites `email` with `role`; returns the invitation id. */
  const invite = async (token: string, orgId: string, email: string, role: string) => {
    const response = await auth(token)
      .post(`/api/v1/organizations/${orgId}/invitations`)
      .send({ email, role });
    expect(response.status).toBe(201);
    return response.body as { id: string; email: string; role: string; status: string; created_at: string };
  };

  /** Initiates the invitation accept request (caller awaits + asserts). */
  const accept = (token: string, invitationId: string) => {
    return auth(token).post(`/api/v1/invitations/${invitationId}/accept`);
  };

  // -------------------------------------------------------------------------
  // Organizations CRUD (§4.2)
  // -------------------------------------------------------------------------

  it('create: creator becomes owner and the organization is listed (§4.2)', async () => {
    if (!reachable.value) return;

    const { token, user } = await register('create');
    const org = await createOrg(token, 'Acme Sandbox');
    expect(org).toMatchObject({ id: expect.any(String), name: 'Acme Sandbox' });
    expect(org.created_at).toBeTruthy();
    expect(org.updated_at).toBeTruthy();

    const listed = await auth(token).get('/api/v1/organizations').expect(200);
    expect(listed.body.data.map((o: { id: string }) => o.id)).toContain(org.id);

    const members = await prisma.organizationMember.findMany({ where: { organizationId: org.id } });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: user.id, role: 'owner' });
  });

  it('create validates the name: empty and over-length → 400 (§4.2 D7)', async () => {
    if (!reachable.value) return;
    const { token } = await register('namebounds');

    for (const name of ['   ', 'x'.repeat(201)]) {
      const response = await auth(token).post('/api/v1/organizations').send({ name });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('update: owner renames; viewer gets 403; non-member gets 404 (D1/D3)', async () => {
    if (!reachable.value) return;

    const owner = await register('update-owner');
    const viewer = await register('update-viewer');
    const outsider = await register('update-outsider');

    // Outsider's own organization — invisible to others.
    const outsiderOrg = await createOrg(outsider.token, 'Outsider Org');

    const org = await createOrg(owner.token, 'Before Rename');
    await invite(owner.token, org.id, viewer.user.email, 'viewer');
    const inviteId = (await auth(owner.token).get(`/api/v1/organizations/${org.id}/invitations`).expect(200)).body.data[0].id;
    await accept(viewer.token, inviteId);

    const renamed = await auth(owner.token)
      .patch(`/api/v1/organizations/${org.id}`)
      .send({ name: 'After Rename' })
      .expect(200);
    expect(renamed.body.name).toBe('After Rename');
    expect(renamed.body.updated_at).not.toBe(renamed.body.created_at);

    const viewerDenied = await auth(viewer.token)
      .patch(`/api/v1/organizations/${org.id}`)
      .send({ name: 'Nope' });
    expect(viewerDenied.status).toBe(403);
    expect(viewerDenied.body.error.code).toBe('FORBIDDEN');

    const outsiderDenied = await auth(outsider.token)
      .patch(`/api/v1/organizations/${outsiderOrg.id}`)
      .send({ name: 'Hijack' });
    expect(outsiderDenied.status).toBe(404);
    expect(outsiderDenied.body.error.code).toBe('NOT_FOUND');
  });

  it('delete: owner-only; subsequent access yields 404 for everyone (§4.2 D9)', async () => {
    if (!reachable.value) return;

    const owner = await register('delete-owner');
    const admin = await register('delete-admin');
    const org = await createOrg(owner.token, 'Doomed Org');
    await invite(owner.token, org.id, admin.user.email, 'admin');
    const inviteId = (await auth(owner.token).get(`/api/v1/organizations/${org.id}/invitations`).expect(200)).body.data[0].id;
    await accept(admin.token, inviteId);

    const adminDenied = await auth(admin.token).delete(`/api/v1/organizations/${org.id}`);
    expect(adminDenied.status).toBe(403);

    await auth(owner.token).delete(`/api/v1/organizations/${org.id}`).expect(204);

    const after = await auth(owner.token).get(`/api/v1/organizations/${org.id}`);
    expect(after.status).toBe(404);
    expect(after.body.error.code).toBe('NOT_FOUND');
  });

  it('tenant isolation: a non-member never learns an organization exists (D1)', async () => {
    if (!reachable.value) return;

    const { token } = await register('isolation');
    const org = await createOrg(token, 'Isolated Org');

    const stranger = await register('isolation-stranger');
    const responses = await Promise.all([
      auth(stranger.token).get(`/api/v1/organizations/${org.id}`),
      auth(stranger.token).patch(`/api/v1/organizations/${org.id}`).send({ name: 'x' }),
      auth(stranger.token).get(`/api/v1/organizations/${org.id}/members`),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }

    const malformed = await auth(stranger.token).get('/api/v1/organizations/not-a-uuid');
    expect(malformed.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Members (§4.2, D4)
  // -------------------------------------------------------------------------

  /** Builds an org owned by `owner` with `admin`/`member`/`viewer` members. */
  const buildTeam = async () => {
    const owner = await register('team-owner');
    const admin = await register('team-admin');
    const member = await register('team-member');
    const viewer = await register('team-viewer');
    const org = await createOrg(owner.token, 'Team Org');

    await invite(owner.token, org.id, admin.user.email, 'admin');
    await invite(owner.token, org.id, member.user.email, 'member');
    await invite(owner.token, org.id, viewer.user.email, 'viewer');
    const invitations = (await auth(owner.token).get(`/api/v1/organizations/${org.id}/invitations`).expect(200)).body.data;
    for (const invitation of invitations) {
      const target = invitation.email === admin.user.email ? admin : invitation.email === member.user.email ? member : viewer;
      await accept(target.token, invitation.id).expect(201);
    }
    return { owner, admin, member, viewer, org };
  };

  it('members.list is readable by every role and exposes the user identity (§4.2 D8)', async () => {
    if (!reachable.value) return;

    const { owner, viewer, org } = await buildTeam();

    const listed = await auth(viewer.token).get(`/api/v1/organizations/${org.id}/members`).expect(200);
    expect(listed.body.data).toHaveLength(4);
    const byEmail = Object.fromEntries(
      listed.body.data.map((m: { user: { email: string } }) => [m.user.email, m]),
    );
    expect(byEmail[owner.user.email].role).toBe('owner');
    expect(byEmail[viewer.user.email].role).toBe('viewer');
    expect(listed.body.data[0]).toMatchObject({
      organization_id: org.id,
      role: expect.stringMatching(/^(owner|admin|member|viewer)$/),
      updated_at: expect.any(String),
      user: { id: expect.any(String), email: expect.any(String) },
    });
  });

  it('admin changes a member role but cannot touch owners or grant owner (§4.2 D4)', async () => {
    if (!reachable.value) return;

    const { member, viewer, admin, owner, org } = await buildTeam();

    const promoted = await auth(admin.token)
      .patch(`/api/v1/organizations/${org.id}/members/${member.user.id}`)
      .send({ role: 'viewer' })
      .expect(200);
    expect(promoted.body.role).toBe('viewer');
    expect(promoted.body.updated_at).toBeTruthy();

    const grantOwner = await auth(admin.token)
      .patch(`/api/v1/organizations/${org.id}/members/${viewer.user.id}`)
      .send({ role: 'owner' });
    expect(grantOwner.status).toBe(403);

    const touchOwner = await auth(admin.token)
      .patch(`/api/v1/organizations/${org.id}/members/${owner.user.id}`)
      .send({ role: 'member' });
    expect(touchOwner.status).toBe(403);
  });

  it('owner changes any role, incl. another owner; last owner demotion → 422 (§4.2 D4)', async () => {
    if (!reachable.value) return;

    const { admin, owner, org } = await buildTeam();

    // Promote admin → owner (owner actor may grant owner).
    const promoted = await auth(owner.token)
      .patch(`/api/v1/organizations/${org.id}/members/${admin.user.id}`)
      .send({ role: 'owner' })
      .expect(200);
    expect(promoted.body.role).toBe('owner');

    // With two owners, owner may demote themself.
    const selfDemote = await auth(owner.token)
      .patch(`/api/v1/organizations/${org.id}/members/${owner.user.id}`)
      .send({ role: 'member' })
      .expect(200);
    expect(selfDemote.body.role).toBe('member');

    // Now the remaining owner is the last one: demoting them → 422.
    const lastOwnerDemote = await auth(admin.token)
      .patch(`/api/v1/organizations/${org.id}/members/${admin.user.id}`)
      .send({ role: 'member' });
    expect(lastOwnerDemote.status).toBe(422);
    expect(lastOwnerDemote.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const lastOwnerRemove = await auth(admin.token).delete(
      `/api/v1/organizations/${org.id}/members/${admin.user.id}`,
    );
    expect(lastOwnerRemove.status).toBe(422);
  });

  it('self-service: member self-demotion works, self-promotion is 403, self-removal works (§4.2 D4)', async () => {
    if (!reachable.value) return;

    const { member, org } = await buildTeam();

    await auth(member.token)
      .patch(`/api/v1/organizations/${org.id}/members/${member.user.id}`)
      .send({ role: 'viewer' })
      .expect(200);

    const promote = await auth(member.token)
      .patch(`/api/v1/organizations/${org.id}/members/${member.user.id}`)
      .send({ role: 'member' });
    expect(promote.status).toBe(403);

    await auth(member.token)
      .delete(`/api/v1/organizations/${org.id}/members/${member.user.id}`)
      .expect(204);

    // Removed member no longer sees the organization.
    const after = await auth(member.token).get(`/api/v1/organizations/${org.id}`);
    expect(after.status).toBe(404);
  });

  it('member target restrictions: member cannot change another member (403) and unknown targets are 404 (§4.2 D4)', async () => {
    if (!reachable.value) return;

    const { member, viewer, org } = await buildTeam();

    const other = await auth(member.token)
      .patch(`/api/v1/organizations/${org.id}/members/${viewer.user.id}`)
      .send({ role: 'viewer' });
    expect(other.status).toBe(403);

    const ghost = await auth(member.token).patch(
      `/api/v1/organizations/${org.id}/members/00000000-0000-7000-8000-000000000000`,
    ).send({ role: 'viewer' });
    expect(ghost.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Invitations (§4.2, D5/D6)
  // -------------------------------------------------------------------------

  it('invite: creates a pending invitation with normalized email; conflicts → 409 (§4.2 D5)', async () => {
    if (!reachable.value) return;

    const owner = await register('inv-create');
    const org = await createOrg(owner.token, 'Invite Org');

    const invitation = await invite(owner.token, org.id, '  Mixed@Example.com ', 'admin');
    expect(invitation).toMatchObject({
      email: 'mixed@example.com',
      role: 'admin',
      status: 'pending',
    });
    expect(invitation.created_at).toBeTruthy();

    const duplicate = await auth(owner.token)
      .post(`/api/v1/organizations/${org.id}/invitations`)
      .send({ email: 'mixed@example.com', role: 'admin' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    // Canceled invitations do not block a new one.
    await auth(owner.token)
      .delete(`/api/v1/organizations/${org.id}/invitations/${invitation.id}`)
      .expect(204);
    const reInvite = await invite(owner.token, org.id, 'mixed@example.com', 'member');
    expect(reInvite.status).toBe('pending');
  });

  it('invitations.create: admin may not invite owners (§4.2 D5)', async () => {
    if (!reachable.value) return;

    const { admin, org } = await buildTeam();
    const deny = await auth(admin.token)
      .post(`/api/v1/organizations/${org.id}/invitations`)
      .send({ email: 'future-owner@example.com', role: 'owner' });
    expect(deny.status).toBe(403);
  });

  it('accept: creates membership with the invited role; email binding and lifecycle (§4.2 D5/D6)', async () => {
    if (!reachable.value) return;

    const owner = await register('inv-accept-owner');
    const invitee = await register('inv-accept-invitee');
    const org = await createOrg(owner.token, 'Accept Org');
    const invitation = await invite(owner.token, org.id, invitee.user.email, 'admin');

    const accepted = await accept(invitee.token, invitation.id).expect(201);
    expect(accepted.body).toMatchObject({ organization_id: org.id, role: 'admin', user_id: invitee.user.id });

    const listing = await auth(owner.token).get(`/api/v1/organizations/${org.id}/invitations`).expect(200);
    expect(listing.body.data[0]).toMatchObject({ id: invitation.id, status: 'accepted', accepted_at: expect.any(String) });
  });

  it('accept: another user with the same email? no — email binding hides the invitation (§4.2 D6)', async () => {
    if (!reachable.value) return;

    const owner = await register('inv-binding-owner');
    const invitee = await register('inv-binding-invitee');
    const stranger = await register('inv-binding-stranger');
    const org = await createOrg(owner.token, 'Binding Org');
    const invitation = await invite(owner.token, org.id, invitee.user.email, 'member');

    // A different account receives the same 404 as an unknown id.
    const denied = await accept(stranger.token, invitation.id);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');

    const unknown = await accept(invitee.token, '00000000-0000-7000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(denied.body.error.message);
  });

  it('accept: already-member → 409; non-pending → 422 (§4.2 D5)', async () => {
    if (!reachable.value) return;

    const owner = await register('inv-state-owner');
    const invitee = await register('inv-state-invitee');
    const org = await createOrg(owner.token, 'State Org');

    const first = await invite(owner.token, org.id, invitee.user.email, 'member');
    await accept(invitee.token, first.id).expect(201);

    const alreadyMember = await accept(invitee.token, first.id);
    expect(alreadyMember.status).toBe(409);
    expect(alreadyMember.body.error.code).toBe('CONFLICT');

    const second = await invite(owner.token, org.id, invitee.user.email, 'viewer');
    await auth(owner.token).delete(`/api/v1/organizations/${org.id}/invitations/${second.id}`).expect(204);

    const nonPending = await accept(invitee.token, second.id);
    expect(nonPending.status).toBe(422);
    expect(nonPending.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('cancelInvitation: idempotent no-op; cross-org cancel is 404 (§4.2 D5)', async () => {
    if (!reachable.value) return;

    const ownerA = await register('inv-cancel-a');
    const ownerB = await register('inv-cancel-b');
    const orgA = await createOrg(ownerA.token, 'Cancel A');
    const orgB = await createOrg(ownerB.token, 'Cancel B');

    const invitation = await invite(ownerA.token, orgA.id, 'cancel-target@example.com', 'member');

    // Owner B cannot cancel A's invitation (cross-tenant) → 404.
    const cross = await auth(ownerB.token).delete(
      `/api/v1/organizations/${orgB.id}/invitations/${invitation.id}`,
    );
    expect(cross.status).toBe(404);

    await auth(ownerA.token)
      .delete(`/api/v1/organizations/${orgA.id}/invitations/${invitation.id}`)
      .expect(204);
    await auth(ownerA.token)
      .delete(`/api/v1/organizations/${orgA.id}/invitations/${invitation.id}`)
      .expect(204);
  });

  it('listInvitations pagination: cursor iteration covers pending and historical entries (§4.5)', async () => {
    if (!reachable.value) return;

    const owner = await register('pag-owner');
    const org = await createOrg(owner.token, 'Pagination Org');

    // 7 invitations → page size 5 with has_more, then 2 remaining.
    for (let i = 0; i < 7; i += 1) {
      await invite(owner.token, org.id, `pag-${i}-${RUN}@example.com`, 'member');
    }

    const page1 = await auth(owner.token)
      .get(`/api/v1/organizations/${org.id}/invitations?limit=5`)
      .expect(200);
    expect(page1.body.data).toHaveLength(5);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await auth(owner.token)
      .get(`/api/v1/organizations/${org.id}/invitations?limit=5&cursor=${page1.body.next_cursor}`)
      .expect(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.next_cursor).toBeNull();
    expect(page1.body.data[4].id).not.toBe(page2.body.data[0].id);
  });
});