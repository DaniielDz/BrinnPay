'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '../../../../../components/auth/auth-provider';
import {
  cancelInvitation,
  createInvitation,
  deleteOrganization,
  listInvitations,
  listMembers,
  removeMember,
  retrieveOrganization,
  updateMember,
  updateOrganization,
  type Invitation,
  type Organization,
  type OrganizationMember,
  type Role,
} from '../../../../../lib/brinnpay/client';

const ROLE_ORDER: Role[] = ['owner', 'admin', 'member', 'viewer'];

/** Presentation-side mirror of the phase 4 role matrix (§5.2); enforcement is
 *  server-side. Returns the target members an actor may administer. */
function managedTargets(
  actorRole: Role,
  actorId: string,
): { canManage: (member: OrganizationMember) => boolean; canChangeOwner: boolean } {
  const isSelf = (member: OrganizationMember) => member.user_id === actorId;
  if (actorRole === 'owner') {
    return { canManage: () => true, canChangeOwner: true };
  }
  if (actorRole === 'admin') {
    return { canManage: (member) => member.role !== 'owner' || isSelf(member), canChangeOwner: false };
  }
  // member/viewer: self-service only (self-demotion, leave).
  return { canManage: (member) => isSelf(member), canChangeOwner: false };
}

/**
 * Role options offered for a target row (§5.2): owner actors may pick any role;
 * admin actors pick any non-owner role (owner-granting is owner-only); members
 * and viewers may only self-demote, i.e. strictly lower roles on their own row.
 */
function roleOptions(actorRole: Role, target: OrganizationMember, isSelf: boolean): Role[] | null {
  const lowerOf = (role: Role) => ROLE_ORDER.slice(ROLE_ORDER.indexOf(role) + 1);
  switch (actorRole) {
    case 'owner':
      return ROLE_ORDER;
    case 'admin':
      // Cannot manage owner members and cannot grant the owner role.
      if (!isSelf && target.role === 'owner') return null;
      return ROLE_ORDER.filter((role) => role !== 'owner');
    default:
      // member/viewer: own row only, strictly downward.
      if (!isSelf) return null;
      return lowerOf(actorRole);
  }
}

/**
 * Organization detail (phase 4 §5.1/§5.2): info + rename/delete, members with
 * role management, and invitations. All data is presented from API responses;
 * the API remains the enforcement point, so a non-member receives the
 * not-found state exactly like the API's 404 (D1).
 */
export default function OrganizationDetailPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const router = useRouter();
  const { accessToken, user } = useAuth();

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [inviting, setInviting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setError(null);
    try {
      const org = await retrieveOrganization(accessToken, organizationId);
      const [memberPage, invitationPage] = await Promise.all([
        listMembers(accessToken, organizationId),
        listInvitations(accessToken, organizationId).catch(() => ({ data: [] as Invitation[], next_cursor: null, has_more: false })),
      ]);
      setOrganization(org);
      setRenameValue(org.name);
      setMembers(memberPage.data);
      setInvitations(invitationPage.data);
      setNotFound(false);
    } catch (err) {
      if (err instanceof Error && /not found/i.test(err.message)) {
        setNotFound(true);
      } else {
        setError(err instanceof Error ? err.message : 'Unable to load organization');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, organizationId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  if (!accessToken) return null;

  if (loading) {
    return (
      <section>
        <h1>Organization</h1>
        <p>Loading organization…</p>
      </section>
    );
  }

  if (notFound || !organization) {
    return (
      <section>
        <h1>Organization not found</h1>
        <p>The organization does not exist or you are not a member of it.</p>
        <p>
          <Link href="/dashboard/organizations">Back to organizations</Link>
        </p>
      </section>
    );
  }

  // Actor: the caller's own membership row, derived from the member roster.
  const actor = members.find((member) => member.user_id === user?.id);
  const actorRole = actor?.role ?? 'viewer';
  const { canChangeOwner } = managedTargets(actorRole, user?.id ?? '');

  async function onRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken || !renameValue.trim()) return;
    setActionError(null);
    setRenaming(true);
    try {
      const updated = await updateOrganization(accessToken, organizationId, renameValue.trim());
      setOrganization(updated);
      setRenameValue(updated.name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to rename organization');
    } finally {
      setRenaming(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!accessToken) return;
    if (!window.confirm(`Delete "${organization?.name ?? 'this organization'}"? This removes the organization, its members and invitations.`)) return;
    setActionError(null);
    setDeleting(true);
    try {
      await deleteOrganization(accessToken, organizationId);
      router.replace('/dashboard/organizations');
    } catch (err) {
      setDeleting(false);
      setActionError(err instanceof Error ? err.message : 'Unable to delete organization');
    }
  }

  async function onChangeRole(member: OrganizationMember, event: { target: { value: string } }): Promise<void> {
    if (!accessToken) return;
    const role = event.target.value as Role;
    setActionError(null);
    try {
      await updateMember(accessToken, organizationId, member.user_id, role);
      setMembers((current) =>
        current.map((entry) => (entry.user_id === member.user_id ? { ...entry, role, updated_at: new Date().toISOString() } : entry)),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to change role');
    }
  }

  async function onRemoveMember(member: OrganizationMember): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    try {
      await removeMember(accessToken, organizationId, member.user_id);
      setMembers((current) => current.filter((entry) => entry.user_id !== member.user_id));
      if (member.user_id === user?.id) {
        router.replace('/dashboard/organizations');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to remove member');
    }
  }

  async function onInvite(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setActionError(null);
    setInviting(true);
    try {
      await createInvitation(accessToken, organizationId, { email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail('');
      const refreshed = await listInvitations(accessToken, organizationId);
      setInvitations(refreshed.data);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create invitation');
    } finally {
      setInviting(false);
    }
  }

  async function onCancelInvitation(invitationId: string): Promise<void> {
    if (!accessToken) return;
    setActionError(null);
    try {
      await cancelInvitation(accessToken, organizationId, invitationId);
      setInvitations((current) =>
        current.map((entry) =>
          entry.id === invitationId
            ? { ...entry, status: 'canceled', canceled_at: new Date().toISOString() }
            : entry,
        ),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to cancel invitation');
    }
  }

  const canRename = actorRole === 'owner' || actorRole === 'admin';
  const canDelete = actorRole === 'owner';
  const canManageInvitations = actorRole === 'owner' || actorRole === 'admin';
  // Invitations may simply be unseen if the API denied; treat a failed load as empty.

  return (
    <section>
      <p>
        <Link href="/dashboard/organizations">Back to organizations</Link>
      </p>
      <h1>{organization.name}</h1>

      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {canRename ? (
        <form onSubmit={onRename}>
          <label>
            Organization name
            <input
              type="text"
              name="name"
              required
              maxLength={200}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </label>
          <button type="submit" disabled={renaming || renameValue.trim() === organization.name}>
            {renaming ? 'Saving…' : 'Rename'}
          </button>
        </form>
      ) : null}

      {canDelete ? (
        <button type="button" className="danger" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete organization'}
        </button>
      ) : null}

      <h2>Members</h2>
      <ul>
        {members.map((member) => {
          const isSelf = member.user_id === user?.id;
          const selectable = roleOptions(actorRole, member, isSelf);
          const canRemove = managerMayRemove(actorRole, member, isSelf);
          return (
            <li key={member.user_id}>
              {member.user.name ?? member.user.email} ({member.user.email}) — {member.role}
              {isSelf ? ' (you)' : ''}
              {selectable && selectable.length > 0 ? (
                <select
                  aria-label={`Role for ${member.user.email}`}
                  value={member.role}
                  onChange={(event) => void onChangeRole(member, event)}
                >
                  {selectable.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              ) : null}
              {canRemove ? (
                <button type="button" onClick={() => void onRemoveMember(member)}>
                  {isSelf ? 'Leave organization' : 'Remove'}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canManageInvitations ? (
        <>
          <h2>Invitations</h2>
          <form onSubmit={onInvite}>
            <label>
              Email
              <input
                type="email"
                name="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </label>
            <label>
              Role
              <select
                name="role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
              >
                {ROLE_ORDER.filter((role) => role !== 'owner' || canChangeOwner).map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={inviting}>
              {inviting ? 'Inviting…' : 'Invite'}
            </button>
          </form>
          {invitations.length === 0 ? (
            <p>No invitations yet.</p>
          ) : (
            <ul>
              {invitations.map((invitation) => (
                <li key={invitation.id}>
                  {invitation.email} — {invitation.role} — {invitation.status}
                  {invitation.status === 'pending' ? (
                    <button type="button" onClick={() => void onCancelInvitation(invitation.id)}>
                      Cancel
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function managerMayRemove(actorRole: Role, member: OrganizationMember, isSelf: boolean): boolean {
  if (isSelf) return true; // leave organization
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return member.role !== 'owner';
  return false;
}