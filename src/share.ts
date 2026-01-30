import {
  COOKIE_COPY_TEMPLATE_ID,
  COOKIE_NAME,
} from "openauth-webui-shared-types";

export function createClientIdCookieContent(clientId: string) {
  return createCookieContent(COOKIE_NAME, clientId, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export function createCopyIdCookieContent(copyId: string) {
  return createCookieContent(COOKIE_COPY_TEMPLATE_ID, copyId, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
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
const islog = true;

export function log(...args: any[]) {
  if (islog) {
    console.log(...args);
  }
}
