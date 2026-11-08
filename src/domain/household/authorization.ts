export type MemberRole = 'admin' | 'member' | 'viewer';
export type MemberStatus = 'active' | 'revoked';

export interface MemberAccess {
  role: MemberRole;
  status: MemberStatus;
}

export const canRead = (member: MemberAccess): boolean => member.status === 'active';

export const canWrite = (member: MemberAccess): boolean =>
  member.status === 'active' && member.role !== 'viewer';

export const canAdminister = (member: MemberAccess): boolean =>
  member.status === 'active' && member.role === 'admin';

/** A autorizacao exige grupo cadastrado E remetente ativo nesse mesmo Household. */
export function isAuthorizedSender(
  householdChatId: string,
  incomingChatId: string,
  member: MemberAccess | undefined,
): boolean {
  return householdChatId === incomingChatId && member !== undefined && canRead(member);
}
