// Hono imports
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { setCookie } from "hono/cookie";

// OpenAuthster shared imports
import {
  insertLog,
  OTFusersTable,
  parseDBUser,
  projectTable,
  uiStyleTable,
  totpTokenTable,
  serializeDBUser,
  webauthnCredentialsTable,
  webauthnChallengesTable,
} from "openauth-webui-shared-types/database";
import { drizzle, eq, and } from "openauth-webui-shared-types/drizzle";
import {
  type GetUserListFilters,
  UserListSchemaValidation,
  UserResponseSchemaType,
} from "openauth-webui-shared-types/endpoints";
import {
  COOKIE_COPY_TEMPLATE_ID,
  COOKIE_INVITE_ID,
  COOKIE_NAME,
  parseDBProject,
  Project,
  ProviderConfig,
  PUBLIC_CLIENT_ID,
  totpTable,
} from "openauth-webui-shared-types";
import { getCookiesFromRequest } from "openauth-webui-shared-types/utils";
import type { ResponseData } from "openauth-webui-shared-types/client/user";
import { OTFUsersParsedType } from "openauth-webui-shared-types/database/types";

// OpenAuth imports
import { Theme } from "@openauthjs/openauth/ui/theme";
import { issuer } from "@openauthjs/openauth";

// Internal imports
import Issuer from "../";
import { log } from "../share";
import { D1Storage } from "../db/d1-adapter";
import {
  generateProvidersFromConfig,
  providerConfigMap,
  userExtractResult,
} from "../providers-setup";
import DefaultTheme from "../defaults/theme";
import globalOpenAutsterConfig, { subjects } from "../../openauth.config";
import packageJson from "../../package.json" assert { type: "json" };

import { parse } from "valibot";
import { deleteCache, getCache, setCache } from "../cache";
import { WebHook } from "openauth-webui-shared-types/webhook";
import { createSelfClient } from "openauth-webui-shared-types/providers/utils";
import type { EndpointCtx, EndpointVariables, Params } from "./types";
import { PartialRequestError, RequestError } from "./error";
import { getSecretFromRequest, getTokenFromRequest } from "./shared";
import { IniviteManager } from "./invite";
import { encryptData, verifyData } from "./security";
import type {
  TOTPResponse,
  TOTPElevateData,
  TOTPSetupData,
  TOTPBackupRestoreData,
} from "openauth-webui-shared-types/client/mfa";
import { TotpError } from "openauth-webui-shared-types/client/errors";
import { WebHookEvents } from "openauth-webui-shared-types/webhook/types";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { cors } from "hono/cors";

export const endpoints = new Hono<{
  Bindings: Env;
  Variables: EndpointVariables;
}>();

// MiddleWares /////////////////////////////////////////////////////////

const protectEndpointWithMFA = createMiddleware(async (c, next) => {
  const requireMFA = c.get("requireMFA");
  if (!requireMFA) return next();
  const params: Params = c.get("params");
  const userInfo =
    (c.get("userInfo") as EndpointVariables["userInfo"]) ||
    (await ensureToken({
      token: getTokenFromRequest(c.req.raw),
      clientID: params.clientID!,
      env: c.env,
      ctx: c.executionCtx,
      request: c.req.raw,
    }));
  const mfaToken = getElevatedTokenFromRequest(c.req.raw);

  if (!mfaToken) return c.json({ error: "MFA token required" }, 401);

  const validToken = await isElevatedTokenValid({
    token: mfaToken,
    userID: userInfo.id,
    clientID: userInfo.clientID,
    env: c.env,
  });
  if (validToken.error) {
    return c.json({ error: `Invalid MFA token: ${validToken.error}` }, 401);
  }
  return next();
});
const userInfoRetriver = createMiddleware(async (c, next) => {
  const params: Params = c.get("params");
  const token = getTokenFromRequest(c.req.raw);
  const userInfo = await ensureToken({
    token,
    clientID: params.clientID!,
    env: c.env,
    ctx: c.executionCtx,
    request: c.req.raw,
  });

  c.set("userInfo", userInfo);
  return next();
});

// Utility Endpoints /////////////////////////////////////////////////////////

/**
 * Utility endpoints for health check and version info
 */
endpoints
  .get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  })
  .get("/version", (c) => {
    return c.text(packageJson.version, 200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
    });
  });

/**
 * ClearCache endpoint for clearing the project cache
 * **Will be used in the v0.3.0 of the webUI**
 */
endpoints.get("/clear-cache/:key", (c) => {
  const key = c.req.param("key");
  if (key) {
    deleteCache(key);
  }
  return c.json({ status: "ok" }, 200);
});

// middleware ////////////////////////////////////////////////////////////

endpoints
  .use(
    "*",
    createMiddleware(async (c, next) => {
      const params = await requestToParams(c.req.raw, c.env);
      c.set("params", params);

      if (c.req.raw.url.startsWith("/.well-known/")) return next(); // skip CORS for well-known endpoints

      const { clientID, copyID, inviteID } = params;
      console.log({
        cookies: { clientID, copyID, inviteID },
        url: c.req.raw.url,
      });

      if (params.clientID) {
        c.set("project", await getProjectById(params.clientID, c.env));
      }

      await next();

      if (clientID) {
        setCookie(c, COOKIE_NAME, clientID, {
          httpOnly: true,
          maxAge: 60 * 60 * 24 * 1, // 1 day
        });
      }
      if (copyID) {
        setCookie(c, COOKIE_COPY_TEMPLATE_ID, copyID, {
          httpOnly: true,
          maxAge: 60 * 60 * 24 * 1, // 1 day
        });
      }
      if (inviteID) {
        setCookie(c, COOKIE_INVITE_ID, inviteID, {
          maxAge: 60 * 60 * 24, // 1 day
          httpOnly: true,
        });
      }
    }),
  )
  .use("*", (c, next) => {
    const project = c.get("project") as Project | undefined;
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    return cors({
      origin: project?.originURL || c.env.WEBUI_ORIGIN_URL,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Cookie",
        "x-elevated-token",
      ],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })(c, next);
  });

// Protected endpoints with MFA requirement ////////////////////////////////////////////////////////////

endpoints.use("/qr/validate", async (c, next) => {
  const project = c.get("project");

  if (!project) return c.json({ error: "Project not found" }, 404);
  const qrProviderConfig = project.providers_data.find((p) => p.type == "qr");
  if (!qrProviderConfig || !qrProviderConfig.data.requireMFA) return next();
  c.set("requireMFA", true);
  return next();
});

// Verify if endpoint is protected by MFA and if the user has a valid elevated token, if required
endpoints.use("*", protectEndpointWithMFA);

async function requestToParams(request: Request, env: Env): Promise<Params> {
  const url = new URL(request.url);

  const cookies = getCookiesFromRequest(request);

  let clientIDParams =
    url.searchParams.get("client_id")?.toString() ||
    cookies[COOKIE_NAME] ||
    null;
  const copyIDParams = url.searchParams.get("copy_id")?.toString() || null;
  const inviteID = url.searchParams.get("invite_id")?.toString() || null;

  log(
    `Parsed params - clientIDParams: ${clientIDParams}, cookies: ${JSON.stringify(
      cookies,
    )}`,
  );

  if (!clientIDParams) {
    const project = await drizzle(env.AUTH_DB)
      .select()
      .from(projectTable)
      .where(eq(projectTable.authEndpointURL, url.hostname))
      .get();
    if (project) {
      clientIDParams = project.clientID;
      setProjectToCache(parseDBProject(project));
    }
  }

  return {
    url,
    clientID: clientIDParams || null,
    copyID: copyIDParams || cookies[COOKIE_COPY_TEMPLATE_ID] || null,
    inviteID: inviteID || cookies[COOKIE_INVITE_ID] || null,
  };
}

// Endpoints /////////////////////////////////////////////////////////////

const user_users_endpoints_middleware = createMiddleware(async (c, next) => {
  const params: Params = c.get("params");
  const project = await getProject({
    id: params.clientID!,
    env: c.env,
    ctx: c,
  });
  if (!project)
    throw new RequestError({
      message: "Project not found",
      status: 404,
      endpoint: new URL(c.req.url).pathname,
      params,
      request: c.req.raw,
    });
  const secret = await getSecretFromRequest(c.req.raw, project);
  if (secret.error)
    throw new RequestError({
      message: `Unauthorized: ${secret.error}`,
      status: 401,
      endpoint: new URL(c.req.url).pathname,
      params,
      request: c.req.raw,
    });
  c.set("project", project);
  return next();
});

endpoints.use("/user/*", user_users_endpoints_middleware);
endpoints.use("/users/*", user_users_endpoints_middleware);

/**
 * Manage single user by userID and clientID
 * Endpoints:
 * - GET /user/:clientID/:userID - get user details
 * - PUT /user/:clientID/:userID - update user (identifier and data fields only)
 * - DELETE /user/:clientID/:userID - delete user
 */
endpoints
  .get("/user/:clientID/:userID", async (c) => {
    const { clientID, userID } = c.req.param();
    try {
      const userTable = OTFusersTable(clientID);
      const user = await drizzle(c.env.AUTH_DB)
        .select()
        .from(userTable)
        .where(eq(userTable.id, userID))
        .get();

      if (!user) return c.json({ error: "User not found" }, 404);
      return c.json(
        parse(UserListSchemaValidation, {
          success: true,
          data: { users: [parseDBUser(user) as OTFUsersParsedType], total: 1 },
          error: null,
        } satisfies UserResponseSchemaType),
      );
    } catch (err) {
      if (err instanceof RequestError) throw err;

      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/user/:clientID/:userID",
        params: c.get("params"),
        project: c.get("project"),
        log: true,
        request: c.req.raw,
        responseInit: {
          body: JSON.stringify({
            success: false,
            data: null,
            error: err instanceof Error ? err.message : String(err),
          } satisfies UserResponseSchemaType),
        },
      });
    }
  })
  .put("/user/:clientID/:userID", async (c) => {
    const { clientID, userID } = c.req.param();
    try {
      const newData = (await c.req.json()) as Partial<
        ReturnType<typeof OTFusersTable>["$inferSelect"]
      >;
      const allowedFields = [
        "identifier",
        "data",
        "session_public",
        "session_private",
      ];
      const filteredData = Object.fromEntries(
        Object.entries(newData).filter(([key]) => allowedFields.includes(key)),
      ) as Partial<OTFUsersParsedType>;
      const userTable = OTFusersTable(clientID);

      const user = await drizzle(c.env.AUTH_DB)
        .update(userTable)
        .set(serializeDBUser(filteredData))
        .where(eq(userTable.id, userID))
        .returning()
        .get();

      if (!user) return c.json({ error: "User not found" }, 404);

      return c.json(
        parse(UserListSchemaValidation, {
          success: true,
          data: { users: [parseDBUser(user) as OTFUsersParsedType], total: 1 },
          error: null,
        } satisfies UserResponseSchemaType),
      );
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/user/:clientID/:userID",
        params: c.get("params"),
        project: c.get("project"),
        log: true,
        request: c.req.raw,
        responseInit: {
          body: JSON.stringify({
            success: false,
            data: null,
            error: err instanceof Error ? err.message : String(err),
          } satisfies UserResponseSchemaType),
        },
      });
    }
  })
  .delete("/user/:clientID/:userID", async (c) => {
    const { clientID, userID } = c.req.param();
    try {
      const userTable = OTFusersTable(clientID);
      const deleteResult = await drizzle(c.env.AUTH_DB)
        .delete(userTable)
        .where(eq(userTable.id, userID))
        .returning()
        .run();
      if (!deleteResult.success) {
        throw new PartialRequestError("Failed to delete user", 400);
      }
      return c.json(
        {
          success: true,
          data: null,
          error: null,
        } satisfies UserResponseSchemaType,
        200,
      );
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/user/:clientID/:userID",
        params: c.get("params"),
        project: c.get("project"),
        log: true,
        request: c.req.raw,
        responseInit: {
          body: JSON.stringify({
            success: false,
            data: null,
            error: err instanceof Error ? err.message : String(err),
          } satisfies UserResponseSchemaType),
        },
      });
    }
  });

/**
 * Get a list of users for a given clientID with optional pagination
 * Query params:
 * - limit: number of users to return
 * - page: page number (base 1)
 */
endpoints.get("/users/:clientID", async (c) => {
  const { clientID } = c.req.param();
  try {
    const filters: GetUserListFilters = parseFilters(c.req.query());
    const users = await fetchUserList(clientID, filters, c.env.AUTH_DB);
    return c.json(
      parse(UserListSchemaValidation, {
        success: true,
        data: {
          users,
          total: users.length,
        },
        error: null,
      } satisfies UserResponseSchemaType),
    );
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError({
      message: err instanceof Error ? err.message : String(err),
      status: err instanceof RequestError ? err.status : 500,
      endpoint: "/users/:clientID",
      params: c.get("params"),
      project: c.get("project"),
      request: c.req.raw,
      responseInit: {
        body: JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          data: null,
        } satisfies UserResponseSchemaType),
      },
    });
  }
});

/**
 * Public session data management for the authenticated user
 */
endpoints.use(
  "/session/*",
  createMiddleware(async (c, next) => {
    const token = getTokenFromRequest(c.req.raw);
    const params: Params = c.get("params");
    try {
      console.log("Authenticating session with token:", { url: c.req.url });
      const userInfo = await ensureToken({
        token,
        clientID: params.clientID!,
        env: c.env,
        ctx: c.executionCtx,
        request: c.req.raw,
      });
      c.set("userInfo", userInfo);
    } catch (err) {
      const params: Params = c.get("params");
      if (err instanceof PartialRequestError)
        throw new RequestError({
          message: err.message,
          status: err.status,
          endpoint: new URL(c.req.url).pathname,
          params,
          project:
            (await getProject({
              id: params.clientID!,
              env: c.env,
              ctx: c,
            })) || undefined,
          request: c.req.raw,
        });
    }

    return next();
  }),
);

endpoints
  .get("/session/public/:clientID", async (c) => {
    try {
      const userInfo = c.get("userInfo")!;

      const userSession = await getUserPublicData(
        userInfo.id,
        userInfo.clientID,
        c.env,
      );

      return c.json(userSession, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/public/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  })
  .patch("/session/public/:clientID", async (c) => {
    try {
      const userInfo = c.get("userInfo")!;

      const data = await c.req.json();

      const updateResult = await updateUserPublicData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
        newData: data,
        skipMerge: false,
      });

      if (!updateResult.success) {
        throw new PartialRequestError(
          updateResult.error || "Failed to update user data",
          400,
        );
      }

      return c.json(updateResult, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/public/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  })
  .delete("/session/public/:clientID", async (c) => {
    try {
      const userInfo = c.get("userInfo")!;

      const updateResult = await updateUserPublicData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
        newData: null,
        skipMerge: true,
      });

      if (!updateResult.success) {
        throw new RequestError({
          message: updateResult.error || "Failed to delete user data",
          status: 400,
          project: c.get("project"),
          params: c.get("params"),
          request: c.req.raw,
        });
      }

      return c.json(updateResult, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/public/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  });

/**
 * Private session data management for the authenticated user
 */

endpoints.use(
  "/session/private/:clientID",
  createMiddleware(async (c, next) => {
    const project = await getProject({
      id: c.req.param("clientID")!,
      env: c.env,
      ctx: c,
    });

    if (!project) {
      throw new RequestError({
        message: `Project with clientID ${c.req.param("clientID")} not found`,
        status: 404,
        endpoint: new URL(c.req.url).pathname,
        params: c.get("params"),
        request: c.req.raw,
      });
    }
    const secret = await getSecretFromRequest(c.req.raw, project);
    if (secret.error)
      throw new RequestError({
        message: `Unauthorized: ${secret.error}`,
        status: 401,
        endpoint: new URL(c.req.url).pathname,
        params: c.get("params"),
        request: c.req.raw,
      });
    return next();
  }),
);

endpoints
  .get("/session/private/:clientID", async (c) => {
    try {
      const userInfo = c.get("userInfo");

      const responseData = await getUserPrivateData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
      });

      if (!responseData.success) {
        throw new RequestError({
          message: responseData.error || "Failed to fetch user data",
          status: 400,
          project: await getProject({
            id: c.req.param("clientID")!,
            env: c.env,
            ctx: c,
          }),
          params: c.get("params"),
          request: c.req.raw,
          responseInit: {
            body: JSON.stringify({
              success: false,
              data: null,
              error: responseData.error || "Failed to fetch user data",
            } satisfies UserResponseSchemaType),
          },
        });
      }

      return c.json(responseData, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/private/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  })
  .patch("/session/private/:clientID", async (c) => {
    const userInfo = c.get("userInfo");
    try {
      const updateResult = await updateUserPrivateData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
        newData: await c.req.json(),
        skipMerge: false,
      });

      if (!updateResult.success) {
        throw new RequestError({
          message: updateResult.error || "Failed to update user data",
          status: 400,
          project: c.get("project"),
          params: c.get("params"),
          request: c.req.raw,
          responseInit: {
            body: JSON.stringify({
              success: false,
              data: null,
              error: updateResult.error || "Failed to update user data",
            } satisfies UserResponseSchemaType),
          },
        });
      }

      return c.json(updateResult, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/private/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  })
  .delete("/session/private/:clientID", async (c) => {
    try {
      const userInfo = c.get("userInfo");

      const updateResult = await updateUserPrivateData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
        newData: null,
        skipMerge: true,
      });

      if (!updateResult.success) {
        throw new RequestError({
          message: updateResult.error || "Failed to delete user data",
          status: 400,
          project: c.get("project"),
          params: c.get("params"),
          request: c.req.raw,
          responseInit: {
            body: JSON.stringify({
              success: false,
              data: null,
              error: updateResult.error || "Failed to delete user data",
            } satisfies UserResponseSchemaType),
          },
        });
      }

      return c.json(updateResult, 200);
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof RequestError ? err.status : 500,
        endpoint: "/session/private/:clientID",
        params: c.get("params"),
        project: c.get("project"),
        request: c.req.raw,
      });
    }
  });

// Auth middleware ///////////////////////////////////////////////////////////

endpoints.use(
  "*",
  createMiddleware(async (c, next) => {
    if (c.req.url.startsWith("/.well-known/")) return next(); // skip for well-known endpoints
    const params: Params = c.get("params");

    if (!params.clientID) {
      return c.json({ error: "Unauthorized: Missing client ID" }, 401);
    }

    const project = await getProject({
      id: params.clientID,
      env: c.env,
      ctx: c,
    });
    if (!project) {
      return c.json(
        {
          error: `Invalid client_id or project not found, (client_id: ${params.clientID})`,
        },
        401,
      );
    }
    c.set("project", project);

    return next();
  }),
);

// TOTP endpoints ///////////////////////////////////////////////////////////

function userInfoToLabel(userInfo: Record<string, any>): string {
  const d = (userInfo.data ?? {}) as Record<string, string>;
  if (d.email) return d.email;
  else if (d.name) return d.name;
  else return userInfo.identifier;
}

endpoints.use(
  "/totp/*",
  createMiddleware(async (c, next) => {
    const params: Params = c.get("params");
    const project = c.get("project");
    if (!project) return c.json({ error: "Project not found" }, 404);
    const userInfo = await ensureToken({
      token: getTokenFromRequest(c.req.raw),
      clientID: params.clientID!,
      env: c.env,
      ctx: c.executionCtx,
      request: c.req.raw,
    });
    c.set("userInfo", userInfo);
    c.set("project", project);
    return next();
  }),
);

function totpResponse<Data>(data: TOTPResponse<Data>): TOTPResponse<Data> {
  return data;
}

function getElevatedTokenFromRequest(request: Request): string | null {
  return request.headers.get("x-elevated-token");
}

async function isElevatedTokenValid({
  token,
  userID,
  clientID,
  env,
}: {
  token: string;
  userID: string;
  clientID: string;
  env: Env;
}): Promise<{ valid: boolean; error?: TotpError["type"] }> {
  const db = drizzle(env.AUTH_DB);
  const totpRecord = await db
    .select({
      token_expires_at: totpTokenTable.token_expires_at,
      token: totpTokenTable.token,
    })
    .from(totpTokenTable)
    .where(
      and(
        eq(totpTokenTable.user_id, userID),
        eq(totpTokenTable.token, token),
        eq(totpTokenTable.clientID, clientID),
      ),
    )
    .get();

  if (!totpRecord) return { valid: false, error: "totp_token_not_found" };

  const tokenExpired =
    Date.now() > new Date(totpRecord.token_expires_at).getTime();
  if (tokenExpired) {
    // Token is expired, delete it from the database
    await db
      .delete(totpTokenTable)
      .where(eq(totpTokenTable.token, totpRecord.token))
      .run();
    return { valid: false, error: "totp_token_expired" };
  }

  return { valid: true };
}

async function removeBackupCodeFromDB({
  userID,
  clientID,
  env,
  hash,
  current_backups,
}: {
  userID: string;
  clientID: string;
  env: Env;
  hash: string;
  current_backups: string[];
}) {
  const db = drizzle(env.AUTH_DB);

  return db
    .update(totpTable)
    .set({
      backup_codes: current_backups.filter((c) => c !== hash),
    })
    .where(
      and(
        eq(totpTable.user_id, userID),
        eq(totpTable.clientID, clientID),
        eq(totpTable.is_verified, true),
      ),
    )
    .run();
}

async function isValidBackupCode({
  code,
  userID,
  clientID,
  env,
}: {
  code: string;
  userID: string;
  clientID: string;
  env: Env;
}): Promise<
  | { valid: false; error: TotpError["type"] }
  | {
      valid: true;
      error?: undefined;
      /**
       * Function to remove the used backup code from the database. Should be called after successful verification of the backup code to ensure it can't be used again.
       */
      removeCode: () => ReturnType<typeof removeBackupCodeFromDB>;
    }
> {
  const db = drizzle(env.AUTH_DB);
  const totpRecord = await db
    .select({
      backup_codes: totpTable.backup_codes,
    })
    .from(totpTable)
    .where(
      and(
        eq(totpTable.user_id, userID),
        eq(totpTable.clientID, clientID),
        eq(totpTable.is_verified, true),
      ),
    )
    .get();

  if (!totpRecord) return { valid: false, error: "totp_not_setup" };

  for await (const encryptedCode of totpRecord.backup_codes as string[]) {
    const codeIsValid = await verifyData(code, encryptedCode);
    if (codeIsValid)
      return {
        valid: true,
        removeCode: () =>
          removeBackupCodeFromDB({
            userID,
            clientID,
            env,
            hash: encryptedCode,
            current_backups: totpRecord.backup_codes as string[],
          }),
      };
  }
  return { valid: false, error: "totp_backup_code_invalid" };
}

async function removeTOTPForUser({
  userID,
  clientID,
  env,
}: {
  userID: string;
  clientID: string;
  env: Env;
}) {
  const db = drizzle(env.AUTH_DB);
  await db
    .delete(totpTable)
    .where(and(eq(totpTable.user_id, userID), eq(totpTable.clientID, clientID)))
    .run();
}

async function generateTOTP({
  label,
  project,
  secret,
}: {
  label: string;
  project: Project;
  secret?: string;
}) {
  const { Secret, TOTP } = await import("otpauth");

  const base32Secret = secret ?? new Secret({ size: 20 }).base32;

  return {
    totp: new TOTP({
      issuer: project.clientID,
      label,
      secret: base32Secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    }),
    secret: base32Secret,
  };
}

const TOTP_VALID_WINDOW = 1; // allow codes from 30 seconds before and after
/**
 * TOTP token expiration time in milliseconds. After this time, the user will need to re-verify TOTP to get a new token.
 */
const TOTP_TOKEN_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

endpoints
  .post("/totp/setup", async (c) => {
    const project = c.get("project");
    const userInfo = c.get("userInfo")!;
    const db = drizzle(c.env.AUTH_DB);
    if (
      await db
        .select({ id: totpTable.user_id })
        .from(totpTable)
        .where(
          and(
            eq(totpTable.user_id, userInfo.id),
            eq(totpTable.clientID, project.clientID),
            eq(totpTable.is_verified, true),
          ),
        )
        .get()
    ) {
      return c.json(
        totpResponse({
          error: "totp_already_setup",
          success: false,
        }),
        400,
      );
    }

    const totp = await generateTOTP({
      label: userInfoToLabel(userInfo),
      project,
    });

    const uri = totp.totp.toString();

    const backupCodes = Array.from({ length: 5 }).map(() =>
      crypto.randomUUID().replaceAll("-", "").slice(0, 10),
    );

    const encryptedBackupCodes = await Promise.all(
      backupCodes.map(encryptData),
    );

    await db
      .insert(totpTable)
      .values({
        clientID: project.clientID,
        user_id: userInfo.id,
        secret: totp.secret,
        created_at: new Date().toISOString(),
        backup_codes: encryptedBackupCodes,
      })
      .onConflictDoUpdate({
        target: totpTable.user_id,
        set: {
          secret: totp.secret,
          created_at: new Date().toISOString(),
          backup_codes: encryptedBackupCodes,
        },
      })
      .run();

    await new WebHook({
      db: c.env.AUTH_DB,
    }).trigger({
      clientID: project.clientID,
      event: "mfa_setup",
      data: {
        userID: userInfo.id,
      },
      secret: project.secret,
      log: true,
      request: c.req.raw,
    });

    return c.json(
      totpResponse<TOTPSetupData>({
        success: true,
        data: {
          uri,
          secret: totp.secret,
          backupCodes,
        },
      }),
    );
  })
  .post("/totp/confirm", async (c) => {
    const userInfo = c.get("userInfo")!;

    const { code } = await c.req.json();

    const db = drizzle(c.env.AUTH_DB);

    const user_totp = await db
      .select()
      .from(totpTable)
      .where(
        and(
          eq(totpTable.user_id, userInfo.id),
          eq(totpTable.clientID, userInfo.clientID),
        ),
      )
      .get();

    if (!user_totp) {
      return c.json(
        totpResponse({ error: "totp_not_setup", success: false }),
        404,
      );
    } else if (user_totp.is_verified) {
      return c.json(
        totpResponse({ error: "totp_already_setup", success: false }),
        400,
      );
    }
    if (
      new Date(user_totp.created_at).getTime() - Date.now() >
      TOTP_TOKEN_EXPIRATION_MS
    ) {
      await db
        .delete(totpTable)
        .where(
          and(
            eq(totpTable.user_id, userInfo.id),
            eq(totpTable.clientID, userInfo.clientID),
          ),
        )
        .run();

      return c.json(
        totpResponse({ error: "totp_setup_expired", success: false }),
        400,
      );
    }

    const { TOTP } = await import("otpauth");
    const project =
      (c.get("project") as Project) ||
      (await getProjectById(c.get("params").clientID!, c.env));

    const totp = new TOTP({
      issuer: project.clientID,
      secret: user_totp.secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });

    const delta = totp.validate({ token: code, window: TOTP_VALID_WINDOW });

    if (delta === null) {
      return c.json(
        totpResponse({ error: "invalid_code", success: false }),
        400,
      );
    }
    await db
      .update(totpTable)
      .set({
        is_verified: true,
      })
      .where(
        and(
          eq(totpTable.user_id, user_totp.user_id),
          eq(totpTable.clientID, user_totp.clientID),
        ),
      )
      .run();

    await new WebHook({
      db: c.env.AUTH_DB,
    }).trigger({
      clientID: project.clientID,
      event: "mfa_confirmed",
      data: {
        userID: userInfo.id,
      },
      request: c.req.raw,
      secret: project.secret,
      log: true,
    });

    return c.json(totpResponse<null>({ success: true, data: null }), 200);
  })
  /**
   * Two ways to remove TOTP:
   * - With TOTP token
   * - With Backup code
   */
  .post("/totp/remove", async (c) => {
    const userInfo = c.get("userInfo");
    const project = c.get("project");
    const elevatedToken = getElevatedTokenFromRequest(c.req.raw);

    if (elevatedToken) {
      const tokenValid = await isElevatedTokenValid({
        token: elevatedToken,
        userID: userInfo.id,
        clientID: project.clientID,
        env: c.env,
      });

      if (!tokenValid.valid) {
        return c.json(
          totpResponse({
            error: tokenValid.error || "request_failed",
            success: false,
          }),
          400,
        );
      }
      await removeTOTPForUser({
        userID: userInfo.id,
        clientID: project.clientID,
        env: c.env,
      });

      await new WebHook({
        db: c.env.AUTH_DB,
      }).trigger({
        clientID: project.clientID,
        event: "mfa_removed",
        data: {
          userID: userInfo.id,
          method: "token",
        },
        request: c.req.raw,
        secret: project.secret,
        log: true,
      });

      return c.json(totpResponse({ success: true, data: null }), 200);
    }

    const backupCode = (await c.req.json()) as { code?: string };

    if (backupCode.code) {
      const backupCodeValid = await isValidBackupCode({
        code: backupCode.code,
        userID: userInfo.id,
        clientID: project.clientID,
        env: c.env,
      });

      if (!backupCodeValid.valid) {
        return c.json(
          totpResponse({
            error: backupCodeValid.error || "invalid_backup_code",
            success: false,
          }),
          400,
        );
      }

      await removeTOTPForUser({
        userID: userInfo.id,
        clientID: project.clientID,
        env: c.env,
      });

      await new WebHook({
        db: c.env.AUTH_DB,
      }).trigger({
        clientID: project.clientID,
        event: "mfa_removed",
        data: {
          userID: userInfo.id,
          method: "backup_code",
        },
        request: c.req.raw,
        secret: project.secret,
        log: true,
      });

      return c.json(
        totpResponse({
          success: true,
          data: null,
        }),
      );
    }

    return c.json(
      totpResponse({
        error: "request_failed",
        error_description: "must provide either elevated token or backup code",
        success: false,
      }),
      400,
    );
  })
  // code to Token
  .post("/totp/elevate", async (c) => {
    const { code } = (await c.req.json()) as { code: string };
    if (!code)
      return c.json(
        totpResponse({ error: "invalid_code", success: false }),
        400,
      );
    const project = c.get("project");
    const userInfo = c.get("userInfo")!;
    const db = drizzle(c.env.AUTH_DB);

    const user_totp = await db
      .select()
      .from(totpTable)
      .where(
        and(
          eq(totpTable.user_id, userInfo.id),
          eq(totpTable.clientID, project.clientID),
          eq(totpTable.is_verified, true),
        ),
      )
      .get();

    if (!user_totp) {
      return c.json(
        totpResponse({ error: "totp_not_setup", success: false }),
        404,
      );
    }

    const totp = await generateTOTP({
      label: userInfoToLabel(userInfo),
      project,
      secret: user_totp.secret,
    });

    const delta = totp.totp.validate({
      token: code,
      window: TOTP_VALID_WINDOW,
    });

    if (delta === null) {
      return c.json(
        totpResponse({ error: "invalid_code", success: false }),
        400,
      );
    }

    const res = (
      await db
        .insert(totpTokenTable)
        .values({
          token: crypto.randomUUID(),
          clientID: project.clientID,
          user_id: userInfo.id,
          token_expires_at: new Date(
            Date.now() + TOTP_TOKEN_EXPIRATION_MS,
          ).toISOString(),
          created_at: new Date().toISOString(),
        })
        .returning()
    ).at(0);

    if (!res?.token)
      return c.json(
        totpResponse({ error: "failed_to_generate_token", success: false }),
        500,
      );

    return c.json(
      totpResponse<TOTPElevateData>({
        success: true,
        data: { token: res.token, expires_at: res.token_expires_at },
      }),
      200,
    );
  })
  // Token to success
  .post("/totp/validate", async (c) => {
    const { token } = await c.req.json();

    const verifiedToken = await isElevatedTokenValid({
      token,
      userID: c.get("userInfo").id,
      clientID: c.get("project").clientID,
      env: c.env,
    });

    if (!verifiedToken.valid) {
      return c.json(
        totpResponse({
          error: verifiedToken.error || "invalid_token",
          success: false,
        }),
        400,
      );
    } else return c.json(totpResponse({ success: true, data: null }), 200);
  })
  // regenerate secret with a backup code
  .post("/totp/reset", async (c) => {
    const { code } = await c.req.json();
    const userInfo = c.get("userInfo")!;
    const project = c.get("project")!;

    const backupCodeValid = await isValidBackupCode({
      code,
      userID: userInfo.id,
      clientID: project.clientID,
      env: c.env,
    });

    if (!backupCodeValid.valid) {
      return c.json(
        totpResponse({
          error: backupCodeValid.error || "invalid_backup_code",
          success: false,
        }),
        400,
      );
    }

    const totp = await generateTOTP({
      label: userInfoToLabel(userInfo),
      project,
    });

    const db = drizzle(c.env.AUTH_DB);

    await db
      .update(totpTable)
      .set({
        secret: totp.secret,
        is_verified: false,
        created_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(totpTable.user_id, userInfo.id),
          eq(totpTable.clientID, project.clientID),
        ),
      )
      .run();

    await backupCodeValid.removeCode();

    await new WebHook({ db: c.env.AUTH_DB }).trigger({
      clientID: project.clientID,
      event: "mfa_update",
      data: {
        method: "backup_code",
        userID: userInfo.id,
      },
      request: c.req.raw,
      secret: project.secret,
      log: true,
    });

    return c.json(
      totpResponse<TOTPBackupRestoreData>({
        success: true,
        data: {
          uri: totp.totp.toString(),
          secret: totp.secret,
        },
      }),
      200,
    );
  })
  .post("/totp/verify", async (c) => {
    const { code } = await c.req.json();
    const userInfo = c.get("userInfo")!;
    const project = c.get("project")!;

    const totp_user = await drizzle(c.env.AUTH_DB)
      .select({
        secret: totpTable.secret,
      })
      .from(totpTable)
      .where(
        and(
          eq(totpTable.user_id, userInfo.id),
          eq(totpTable.clientID, project.clientID),
          eq(totpTable.is_verified, true),
        ),
      )
      .get();

    if (!totp_user) {
      return c.json(
        totpResponse({
          error: "totp_not_setup",
          success: false,
        }),
        404,
      );
    }

    const delta = (
      await generateTOTP({
        label: userInfoToLabel(userInfo),
        project,
        secret: totp_user?.secret,
      })
    ).totp.validate({
      token: code,
      window: TOTP_VALID_WINDOW,
    });

    if (delta === null) {
      return c.json(
        totpResponse({ error: "invalid_code", success: false }),
        400,
      );
    }

    return c.json(totpResponse({ success: true, data: null }), 200);
  });

// passkey endpoints ///////////////////////////////////////////////////////////
endpoints.use("/passkey/register/*", userInfoRetriver);
endpoints
  .post("/passkey/register/start", async (c) => {
    const project = c.get("project");
    const userInfo = c.get("userInfo");
    const { userDisplayName } = await c.req.json();

    if (!userDisplayName) {
      return c.json({ error: "Missing userDisplayName in request body" }, 400);
    }

    const db = drizzle(c.env.AUTH_DB);

    // 1. Récupérer les credentials existants pour éviter les doublons sur le même appareil
    const existingCredentials = await db
      .select()
      .from(webauthnCredentialsTable)
      .where(eq(webauthnCredentialsTable.user_id, userInfo.id));

    // 2. Générer les options pour le navigateur
    const options = await generateRegistrationOptions({
      rpName: project.clientID.replaceAll("_", " "),
      rpID: new URL(project.originURL!).hostname,
      userID: new Uint8Array(new TextEncoder().encode(userInfo.id)),
      userName: userDisplayName,
      userDisplayName: userDisplayName,
      attestationType: "none",
      excludeCredentials: existingCredentials.map((cred) => ({
        id: cred.credential_id as string,
        transports: ["internal"],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    // 3. Sauvegarder le challenge dans D1 (valide 5 minutes)
    const challengeId = crypto.randomUUID();

    await db.insert(webauthnChallengesTable).values({
      id: challengeId,
      clientID: userInfo.clientID,
      challenge: options.challenge,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });

    // On renvoie le challengeId (pour la suite) et les options pour le navigateur
    return c.json({ challengeId, options });
  })
  .post("/passkey/register/finish", async (c) => {
    const userInfo = c.get("userInfo");
    const project = c.get("project");
    const { challengeId, response } = (await c.req.json()) as {
      challengeId: string;
      response: RegistrationResponseJSON;
    }; // 'response' vient de navigator.credentials.create()

    const db = drizzle(c.env.AUTH_DB);

    const DBchallenge = await db
      .select()
      .from(webauthnChallengesTable)
      .where(and(eq(webauthnChallengesTable.id, challengeId)))
      .get();

    if (
      !DBchallenge ||
      new Date(DBchallenge.expires_at).getTime() < Date.now()
    ) {
      return c.json({ error: "Challenge invalide ou expiré" }, 400);
    }

    const expectedChallenge = DBchallenge.challenge;

    // 2. Vérifier la réponse cryptographique
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: project.originURL!,
        expectedRPID: new URL(project.originURL!).hostname,
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    if (verification.verified && verification.registrationInfo) {
      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      // 3. Sauvegarder la clé publique dans D1
      await db
        .insert(webauthnCredentialsTable)
        .values({
          credential_id: credential.id,
          user_id: userInfo.id,
          clientID: userInfo.clientID,
          public_key: credential.publicKey.toBase64(), // C'est un Uint8Array, Cloudflare D1 gère les blobs (selon config, sinon convertir en base64)
          counter: credential.counter,
          device_type: credentialDeviceType,
          backed_up: credentialBackedUp,
          transports: response.response.transports || [],
          created_at: new Date().toISOString(),
        })
        .run();
      await db
        .delete(webauthnChallengesTable)
        .where(eq(webauthnChallengesTable.id, challengeId))
        .run();
      // 4. Nettoyer le challenge utilisé
      return c.json({
        success: true,
        message: "Passkey enregistré avec succès !",
      });
    }

    return c.json({ error: "Vérification échouée" }, 400);
  });

// admin endpoints //////////////////////////////////////////////////

endpoints.use(
  "/admin/*",
  createMiddleware(async (c, next) => {
    const params: Params = c.get("params");
    const project = await getProject({
      id: params.clientID!,
      env: c.env,
      ctx: c,
    });
    if (!project) return c.json({ error: "Project not found" }, 404);
    const secret = await getSecretFromRequest(c.req.raw, project);
    if (secret.error)
      throw new RequestError({
        message: `Unauthorized: ${secret.error}`,
        status: 401,
        endpoint: new URL(c.req.url).pathname,
        params,
        project,
        request: c.req.raw,
      });

    c.set("project", project);
    return next();
  }),
);

endpoints.delete("/admin/totp/:userID", async (c) => {
  const { userID } = c.req.param();
  const project = c.get("project")!;

  const db = drizzle(c.env.AUTH_DB);
  try {
    await db
      .delete(totpTable)
      .where(
        and(
          eq(totpTable.user_id, userID),
          eq(totpTable.clientID, project.clientID),
        ),
      )
      .run();

    await db
      .delete(totpTokenTable)
      .where(
        and(
          eq(totpTokenTable.user_id, userID),
          eq(totpTokenTable.clientID, project.clientID),
        ),
      )
      .run();

    return c.json(totpResponse<null>({ success: true, data: null }), 200);
  } catch (err) {
    await insertLog({
      type: "error",
      message: `Failed to remove TOTP for user ${userID}: ${err instanceof Error ? err.message : String(err)}`,
      clientID: project.clientID,
      context: {
        userID,
      },
      database: c.env.AUTH_DB,
    });

    return c.json(
      totpResponse<null>({
        success: false,
        error: "request_failed",
        error_description: err instanceof Error ? err.message : String(err),
      }),
      500,
    );
  }
});

// Auth endpoints /////////////////////////////////////////////////

// Restrictions MiddleWares //////////////////////////////////////
endpoints.use(
  "/password/register",
  createMiddleware(async (c, next) => {
    const params: Params = c.get("params");

    if (params.clientID !== PUBLIC_CLIENT_ID || c.req.method !== "POST")
      return next();
    const fd = await c.req.raw.clone().formData();
    const action = fd.get("action")?.toString() as "register" | "verify";
    if (action !== "register") return next();
    const email = fd.get("email")?.toString();
    const isAdmin = (c.env as Env).WEBUI_ADMIN_EMAILS.split(",")
      .map((email) => email.trim())
      .some((adminEmail) => {
        if (adminEmail === email) return true;
      });
    if (!isAdmin) {
      return c.json({ error: "Unauthorized: Not an admin email" }, 401);
    }
    return next();
  }),
);

// Options Cors

/**
 * Allow CORS preflight requests
 */
endpoints.options("*", (c) => {
  const project = c.get("project") as Project | undefined;
  console.log(project);
  return c.text("ok", 200, {
    "Access-Control-Allow-Origin": project?.originURL || "*",
    "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS, DELETE, POST",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-elevated-token",
  });
});

endpoints.all("*", async (c) => {
  const params: Params = c.get("params");
  const project = await getProject({
    id: params.clientID!,
    env: c.env,
    ctx: c,
  });
  const getTheme = () => {
    const isWellKnown = new URL(c.req.raw.url).pathname.startsWith(
      "/.well-known",
    );
    if (isWellKnown || !project) return Promise.resolve(undefined);
    return getThemeFromProject(project, c.env);
  };
  const is = issuer({
    storage: D1Storage({
      database: c.env.AUTH_DB,
      table: params.clientID!,
    }),
    ttl: {
      access: (c.env as any).ACCESS_TTL ?? 900, // 15 minutes in seconds
      refresh: (c.env as any).REFRESH_TTL ?? 604800, // 7 days in seconds
      retention: 0,
      reuse: 60,
    },
    allow: async (input, req) => {
      const incomingUrl = new URL(input.redirectURI);

      // Only allow http and https protocols to prevent protocol-based attacks
      if (!["http:", "https:"].includes(incomingUrl.protocol)) {
        return false;
      }

      // Handle localhost/127.0.0.1 with stricter validation
      if (
        incomingUrl.hostname === "localhost" ||
        incomingUrl.hostname === "127.0.0.1"
      ) {
        // Only allow http for localhost (https typically not configured locally)
        if (incomingUrl.protocol !== "http:") return false;
        return true;
      }

      if (!project?.originURL) return false;

      const projectUrl = new URL(project.originURL);

      // Enforce HTTPS when project URL uses HTTPS (prevent downgrade attacks)
      if (
        projectUrl.protocol === "https:" &&
        incomingUrl.protocol !== "https:"
      ) {
        return false;
      }

      // Validate origin match
      if (incomingUrl.origin === projectUrl.origin) return true;

      return false;
    },
    subjects,
    providers: project
      ? await generateProvidersFromConfig({
          project: project,
          env: c.env,
          copyTemplateId: params.copyID,
          //@ts-ignore
          ctx: c,
        })
      : {},
    theme: await getTheme(),
    success: async (ctx, value, request) => {
      log(
        `Successful authentication with value: `,
        JSON.stringify({ value }, null, 2),
      );

      await (
        await globalOpenAutsterConfig(c.env)
      ).register.onSuccessfulRegistration?.(ctx, value, request);

      const userData = await getOrCreateUser({
        env: c.env,
        value,
        providerConfig: project?.providers_data.find(
          (p) => p.type === value.provider,
        ) as ProviderConfig,
        project: project!,
        params,
        ctx: c,
      });

      return ctx.subject("user", {
        id: userData.parser.id,
        data: userData.dbUser?.data ?? {},
        identifier: userData.dbUser?.identifier ?? "",
        clientID: params.clientID!,
        provider: userData.dbUser?.data?.provider ?? value.provider,
        role: null,
      });
    },
    async error(error, req) {
      console.error(`Error during authentication for ${req.url}:`, error);
      console.log(req);
      throw new RequestError({
        message: `Authentication error: ${(error as Error).message}`,
        status: 500,
        endpoint: req.url,
        params,
        project,
        request: req,
      });
    },
  });
  return is.fetch(c.req.raw, c.env, c.executionCtx);
});

// Auth helper functions //////////////////////////////////////////////////////

function setProjectToCache(project: Project) {
  setCache<Project>(project.clientID, project);
}

function getProjectFromCache(clientID: string): Project | null {
  return getCache<Project>(clientID);
}

async function getProject({
  id,
  env,
  ctx,
}: {
  id: string;
  env: Env;
  ctx: EndpointCtx;
}): Promise<Project | undefined> {
  const projectInCtx = ctx.get("project") as Project | undefined;
  if (projectInCtx && projectInCtx.clientID === id) {
    return projectInCtx;
  }
  const cachedProject = getProjectFromCache(id);
  if (cachedProject) {
    return cachedProject;
  }
  const project = await getProjectById(id, env);
  if (!project) return;
  setProjectToCache(project);
  return project;
}

async function getProjectById(
  clientId: string | undefined,
  env: Env,
): Promise<null | Project> {
  if (clientId === PUBLIC_CLIENT_ID) {
    return {
      themeId: null,
      emailTemplateId: null,
      projectData: undefined as any,
      active: true,
      clientID: PUBLIC_CLIENT_ID,
      created_at: new Date().toISOString(),
      codeMode: "email",
      registerOnInvite: false,
      secret: "",
      authEndpointURL: "",
      cloudflareDomaineID: "",
      originURL: env.WEBUI_ORIGIN_URL,
      providers_data: [
        {
          type: "password",
          enabled: true,
          data: {},
        },
      ],
    } satisfies Project;
  }

  if (!clientId) return null;

  const cachedProject = getCache<Project>(clientId);
  if (cachedProject) {
    return cachedProject;
  }

  const projectData = await drizzle(env.AUTH_DB)
    .select()
    .from(projectTable)
    .where(eq(projectTable.clientID, clientId))
    .get();

  if (!projectData) return null;

  const project = parseDBProject(projectData);
  setCache<Project>(clientId, project);
  return project;
}

async function getThemeFromProject(project: Project, env: Env): Promise<Theme> {
  if (!project.themeId) {
    return DefaultTheme;
  }
  return drizzle(env.AUTH_DB)
    .select()
    .from(uiStyleTable)
    .where(eq(uiStyleTable.id, project.themeId))
    .limit(1)
    .get()
    .then((el) => {
      return el?.themeData ? (el.themeData as Theme) : DefaultTheme;
    });
}

async function userExists(env: Env, identifier: string, clientID: string) {
  const usersTable = OTFusersTable(clientID);
  return drizzle(env.AUTH_DB)
    .select()
    .from(usersTable)
    .where(eq(usersTable.identifier, identifier))
    .limit(1)
    .get()
    .then((res) => (res ? parseDBUser(res) : undefined));
}

async function getOrCreateUser({
  env,
  value,
  providerConfig,
  project,
  params,
  ctx,
}: {
  env: Env;
  value: Record<string, any>;
  providerConfig: ProviderConfig;
  project: Project;
  params: Params;
  ctx: EndpointCtx;
}): Promise<{
  parser: userExtractResult<{}> & { id: string };
  dbUser: Partial<OTFUsersParsedType>;
}> {
  const usersTable = OTFusersTable(project.clientID);
  const userData = await providerConfigMap[
    value.provider as keyof typeof providerConfigMap
  ].parser(value, providerConfig, env, ctx as any);

  const exists = await userExists(env, userData.identifier, project.clientID);

  const inviteHelper = new IniviteManager(env, project, ctx);

  if (!exists) await inviteHelper.handleRegister(params.inviteID);

  const dataToStore = {
    ...(userData.data ?? exists?.data ?? {}),
    provider: exists?.data?.provider || value.provider,
  };
  const userResult = await drizzle(env.AUTH_DB)
    .insert(usersTable)
    .values({
      id: crypto.randomUUID(),
      identifier: userData.identifier,
      data: JSON.stringify(dataToStore),
      created_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: usersTable.identifier,
      set: {
        data: JSON.stringify(dataToStore),
      },
    })
    .returning()
    .then((r) => r.at(0))
    .then((res) => (res ? parseDBUser(res) : undefined));

  if (!userResult) {
    throw new RequestError({
      message: "Failed to create or retrieve user",
      status: 500,
      project,
      params,
      request: ctx.req.raw,
    });
  }
  log(
    `Found or created user ${userResult.id} with data ${JSON.stringify(userData.data)}`,
  );

  await inviteHelper.removeInviteLinkById(params.inviteID!);
  const event: WebHookEvents = exists
    ? "login_success"
    : "registration_success";

  const WebHookResult = (ev: "login_success" | "registration_success") =>
    ev == "login_success"
      ? new WebHook({ db: ctx.env.AUTH_DB }).trigger({
          clientID: params.clientID!,
          event: "login_success",
          secret: project.secret,
          data: {
            userID: userResult.id!,
            provider: value.provider,
          },
          request: ctx.req.raw,
        })
      : new WebHook({ db: ctx.env.AUTH_DB }).trigger({
          clientID: params.clientID!,
          event: "registration_success",
          secret: project.secret,
          data: {
            userID: userResult.id!,
            provider: value.provider,
          },
          request: ctx.req.raw,
        });

  const webhookResult = (await WebHookResult(event)).filter(
    (res) => !res.success,
  );

  if (webhookResult.length > 0)
    await insertLog({
      clientID: params.clientID!,
      type: "warning",
      message: `One or more webhooks failed to trigger for ${
        exists ? "login" : "registration"
      } of user with identifier ${userData.identifier}. Failed webhooks: ${webhookResult
        .map((r) => r.id)
        .join(", ")}`,
      database: env.AUTH_DB,
      endpoint: `${exists ? "login" : "registration"} flow`,
    });

  return {
    parser: { ...userData, id: userResult.id! },
    dbUser: userResult,
  };
}

// Helper functions ////////////////////////////////////////////////////////

async function fetchUserList(
  clientID: string,
  filters: GetUserListFilters,
  database: D1Database,
): Promise<Array<OTFUsersParsedType>> {
  const userTable = OTFusersTable(clientID);
  if (filters.limit) {
    return (
      await drizzle(database)
        .select()
        .from(userTable)
        .limit(Number(filters.limit))
        .offset(
          filters.limit
            ? (Number(filters.page) - 1) * Number(filters.limit)
            : 0,
        )
        .all()
    ).map(parseDBUser) as OTFUsersParsedType[];
  } else {
    return (
      await drizzle(database).select().from(OTFusersTable(clientID)).all()
    ).map(parseDBUser) as OTFUsersParsedType[];
  }
}

function parseFilters(query: Record<string, string>): GetUserListFilters {
  return {
    ...query,
    limit: query.limit ? Number(query.limit) : undefined,
    page: query.page ? Number(query.page) : undefined,
  } as GetUserListFilters;
}

async function ensureToken({
  token,
  clientID,
  env,
  ctx,
  request,
}: {
  token: string | null;
  clientID: string;
  env: Env;
  ctx: ExecutionContext;
  request: Request;
}) {
  if (!token) {
    throw new PartialRequestError("Unauthorized: Missing token", 401);
  }

  const origin = new URL(request.url).origin;

  const selfClient = createSelfClient({
    env,
    ctx,
    clientID,
    issuerURI: origin,
    //@ts-ignore
    issuer: Issuer,
  });
  try {
    const verified = await selfClient.verify(subjects, token);
    if (verified.err) {
      throw new PartialRequestError("Unauthorized: Invalid token", 401);
    }
    return verified.subject.properties;
  } catch (err) {
    console.log("Error verifying token:", {
      issuerURI: origin,
      clientID,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PartialRequestError("Unauthorized: Invalid token", 401);
  }
}

async function getUserPrivateData({
  userID,
  clientID,
  env,
}: {
  userID: string;
  clientID: string;
  env: Env;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);

  return drizzle(env.AUTH_DB)
    .select({
      private: usersTable.session_private,
      public: usersTable.session_public,
      id: usersTable.id,
      identifier: usersTable.identifier,
      data: usersTable.data,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userID))
    .limit(1)
    .get()
    .then((el) => {
      if (!el) {
        return {
          success: false,
          error: "User not found",
        };
      }
      return {
        data: {
          private: el.private ? JSON.parse(el.private) : null,
          public: el.public ? JSON.parse(el.public) : null,
          user_id: el.id,
          user_identifier: el.identifier,
          userInfo: el.data ? JSON.parse(el.data as string) : null,
        },
        success: true,
      };
    });
}

function getUserPublicData(
  userID: string,
  clientID: string,
  env: Env,
): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);
  return drizzle(env.AUTH_DB)
    .select({
      public: usersTable.session_public,
      id: usersTable.id,
      identifier: usersTable.identifier,
      data: usersTable.data,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userID))
    .limit(1)
    .get()
    .then((el) => {
      if (!el) {
        return {
          success: false,
          error: "User not found",
        };
      }
      return {
        success: true,
        data: {
          public: el.public ? JSON.parse(el.public) : null,
          private: null,
          user_id: el.id,
          user_identifier: el.identifier,
          userInfo: el.data ? JSON.parse(el.data as string) : null,
        },
      };
    })
    .catch((err) => {
      log("Error fetching public data:", err);
      return {
        success: false,
        error: "Internal server error: " + err.message,
      };
    });
}

async function updateUserPublicData({
  userID,
  clientID,
  env,
  newData,
  skipMerge = false,
}: {
  userID: string;
  clientID: string;
  env: Env;
  newData: any;
  skipMerge?: boolean;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);
  const currentData = await getUserPublicData(userID, clientID, env);
  if (!currentData.success) {
    return {
      success: false,
      error: "User not found",
    };
  }
  const mergedData: Record<string, any> = skipMerge
    ? newData
    : {
        ...(currentData.data?.public || {}),
        ...newData,
      };
  return drizzle(env.AUTH_DB)
    .update(usersTable)
    .set({
      session_public: JSON.stringify(mergedData),
    })
    .where(eq(usersTable.id, userID))
    .limit(1)
    .returning({
      session_public: usersTable.session_public,
      data: usersTable.data,
    })
    .then((el) => {
      if (el.length === 0) {
        return {
          success: false,
          error: "User not found",
        };
      }
      return {
        success: true,
        data: {
          public: JSON.parse(el.at(0)?.session_public!),
          private: null,
          user_id: userID,
          user_identifier: currentData.data?.user_identifier || "",
          userInfo: el[0].data ? JSON.parse(el[0].data as string) : null,
        },
      };
    });
}

async function updateUserPrivateData({
  userID,
  clientID,
  env,
  newData,
  skipMerge = false,
}: {
  userID: string;
  clientID: string;
  env: Env;
  newData: any;
  skipMerge?: boolean;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);
  const currentData = await getUserPrivateData({
    userID,
    clientID,
    env,
  });
  if (!currentData.success) {
    return currentData;
  }
  const mergedData = skipMerge
    ? newData
    : {
        ...currentData.data?.private,
        ...newData,
      };
  return drizzle(env.AUTH_DB)
    .update(usersTable)
    .set({
      session_private: JSON.stringify(mergedData),
    })
    .where(eq(usersTable.id, userID))
    .limit(1)
    .returning({
      session_private: usersTable.session_private,
      session_public: usersTable.session_public,
      id: usersTable.id,
      identifier: usersTable.identifier,
      data: usersTable.data,
    })
    .then((el) => {
      if (el.length === 0) {
        return {
          success: false,
          error: "User not found",
        };
      }
      return {
        success: true,
        data: {
          private: JSON.parse(el.at(0)?.session_private!),
          public: JSON.parse(el.at(0)?.session_public!),
          user_id: userID,
          user_identifier: el.at(0)?.identifier!,
          userInfo: el.at(0)?.data
            ? JSON.parse(el.at(0)?.data as string)
            : null,
        },
      };
    });
}
