import { WebUiInviteLinkTable } from "openauth-webui-shared-types/database";
import { createInviteIdCookieContent } from "./share";
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

/**
 * Trigger on the invite link page, set the inviteId cookie and redirect to the home page.
 * The home page will then use the inviteId cookie to complete the invite flow.
 *
 * *must be triggered on `https://auth.example.com/invite` endpoint*
 */
export async function createResponseFromInviteId({
  id,
  env,
  redirectURI,
}: {
  id: string;
  env: Env;
  redirectURI: string;
}): Promise<Response> {
  await ensureInviteLinkIsValid(id, env);
  const response = new Response(null, {
    status: 302,
    headers: {
      Location: redirectURI,
    },
  });

  response.headers.append("Set-Cookie", createInviteIdCookieContent(id));

  return response;
}
