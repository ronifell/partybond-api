/** Skip integration / simulation accounts in pickers and lists. */
export function isRealAppUser(email: string): boolean {
  const e = email.toLowerCase();
  if (e.endsWith('@partybond.test')) return false;
  if (e.endsWith('@test.partybond')) return false;
  if (/^test[a-z]_\d+@/.test(e)) return false;
  if (e.includes('squad_leader_') || e.includes('squad_invitee_') || e.includes('squad_decline_')) {
    return false;
  }
  return true;
}

