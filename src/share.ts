export const COOKIE_NAME = "oauth_client_id" as const;

export function createCookieContent(clientId: string) {
  return `${COOKIE_NAME}=${clientId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${(60 * 60 * 24 * 30).toString()}`;
}
