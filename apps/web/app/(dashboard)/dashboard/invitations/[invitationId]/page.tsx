'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '../../../../../components/auth/auth-provider';
import { acceptInvitation } from '../../../../../lib/brinnpay/client';

interface AcceptState {
  status: 'idle' | 'pending' | 'success' | 'error';
  message?: string;
  organizationId?: string;
}

/**
 * Invitation accept flow (phase 4 §5.2, D6): the accept URL is how an invited
 * user reaches the flow in the absence of email delivery. The API enforces the
 * email binding; this page only renders the confirmation and maps the canonical
 * error codes to user-facing states.
 */
export default function AcceptInvitationPage() {
  const { invitationId } = useParams<{ invitationId: string }>();
  const { accessToken } = useAuth();

  const [state, setState] = useState<AcceptState>({ status: 'idle' });

  async function onAccept(): Promise<void> {
    if (!accessToken) return;
    setState({ status: 'pending' });
    try {
      const member = await acceptInvitation(accessToken, invitationId);
      setState({ status: 'success', organizationId: member.organization_id });
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : 'UNKNOWN_ERROR';
      const message = err instanceof Error ? err.message : 'Unable to accept the invitation';
      setState({ status: 'error', message: describeFailure(code, message) });
    }
  }

  if (state.status === 'success') {
    return (
      <section>
        <h1>Invitation accepted</h1>
        <p>You are now a member of the organization.</p>
        <p>
          <Link href={`/dashboard/organizations/${state.organizationId}`}>Open the organization</Link>
        </p>
        <p>
          <Link href="/dashboard/organizations">Back to organizations</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Accept invitation</h1>
      {state.status === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.status === 'pending' ? (
        <p>Accepting invitation…</p>
      ) : (
        <button type="button" onClick={() => void onAccept()}>
          Accept invitation
        </button>
      )}
    </section>
  );
}

function describeFailure(code: string, fallback: string): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'This invitation does not exist or was not addressed to your account.';
    case 'BUSINESS_RULE_VIOLATION':
      return 'This invitation is no longer pending (it may have already been used or canceled).';
    case 'CONFLICT':
      return 'You are already a member of this organization.';
    default:
      return fallback;
  }
}