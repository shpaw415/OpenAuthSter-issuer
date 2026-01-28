export const COOKIE_NAME = "oauth_client_id" as const;
export const COOKIE_COPY_TEMPLATE_ID = "oauth_copy_template_id" as const;

export function createClientIdCookieContent(clientId: string) {
  return createCookieContent(COOKIE_NAME, clientId, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export function createCookieContent(
  name: string,
  value: string,
  options?: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    maxAge?: number;
  },
) {
  let cookieString = `${name}=${value}`;

  if (options) {
    if (options.httpOnly) {
      cookieString += "; HttpOnly";
    }
    if (options.secure) {
      cookieString += "; Secure";
    }
    if (options.sameSite) {
      cookieString += `; SameSite=${options.sameSite}`;
    }
    if (options.path) {
      cookieString += `; Path=${options.path}`;
    }
    if (options.maxAge !== undefined) {
      cookieString += `; Max-Age=${options.maxAge.toString()}`;
    }
  }

  return cookieString;
}
