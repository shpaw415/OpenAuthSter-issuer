import { WebUiInviteLinkTable } from "openauth-webui-shared-types/database";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";

export function removeInviteLinkById(
  id: string,
  env: Env,
): Promise<D1Result<unknown>> {
  return drizzle(env.AUTH_DB)
    .delete(WebUiInviteLinkTable)
    .where(eq(WebUiInviteLinkTable.id, id))
    .run();
}

export async function ensureInviteLinkIsValid(
  id: string,
  env: Env,
): Promise<void> {
  const inviteLink = await drizzle(env.AUTH_DB)
    .select({
      expiresAt: WebUiInviteLinkTable.expiresAt,
    })
    .from(WebUiInviteLinkTable)
    .where(eq(WebUiInviteLinkTable.id, id))
    .get();

  if (!inviteLink) {
    throw new Error("Invite link not found");
  }
  if (
    inviteLink.expiresAt &&
    new Date(inviteLink.expiresAt).getTime() < new Date().getTime()
  ) {
    await removeInviteLinkById(id, env);
    throw new Error("Invite link has expired");
  }
}
