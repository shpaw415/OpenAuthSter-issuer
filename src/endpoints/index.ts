// Hono imports
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { setCookie } from "hono/cookie";
import { type ContentfulStatusCode } from "hono/utils/http-status";

// OpenAuthster shared imports
import {
  insertLog,
  OTFusersTable,
  parseDBUser,
  projectTable,
  uiStyleTable,
  serializeDBUser,
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
} from "openauth-webui-shared-types";
import { getCookiesFromRequest } from "openauth-webui-shared-types/utils";
import type { ResponseData } from "openauth-webui-shared-types/client/user";
import { OTFUsersParsedType } from "openauth-webui-shared-types/database/types";

// OpenAuth imports
import { createClient } from "@openauthjs/openauth/client";
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
import { ensureInviteLinkIsValid, removeInviteLinkById } from "../invite-link";

import { parse } from "valibot";

class PartialRequestError extends Error {
  status: ContentfulStatusCode;
  constructor(message: string, status: ContentfulStatusCode) {
    super(message);
    this.status = status;
  }
}
export class RequestError extends Error {
  status: ContentfulStatusCode;
  params?: Params;
  project?: Project;
  endpoint?: string;
  token: boolean = false;
  secret: boolean = false;
  log: boolean = true;
  response: {
    body?: BodyInit;
    init?: ResponseInit;
  } | null = null;
  constructor({
    message,
    status,
    params,
    project,
    endpoint,
    log = true,
    request,
    responseInit,
  }: {
    message: string;
    status: ContentfulStatusCode;
    params?: Params;
    project?: Project;
    endpoint?: string;
    log?: boolean;
    request: Request;
    responseInit?: {
      body?: BodyInit;
      init?: ResponseInit;
    };
  }) {
    super(message);
    this.status = status;
    this.params = params;
    this.project = project;
    this.endpoint = endpoint;
    this.log = log;
    this.token = getTokenFromRequest(request) ? true : false;
    this.secret = getSecretFromRequest(request) ? true : false;
    this.response = responseInit ? responseInit : null;
  }
}

export const endpoints = new Hono<{
  Bindings: Env;
  Variables: { params: Params; project: Project };
}>();

// Utility Endpoints /////////////////////////////////////////////////////////

/**
 * Health check endpoint
 */
endpoints.get("/health", (c) => {
  return c.json({ status: "ok" }, 200);
});

/**
 * OpenAuthster version endpoint
 */
endpoints.get("/version", async (c) => {
  return c.text(packageJson.version, 200);
});

/**
 * Cleanup endpoint for testing
 */
endpoints.get("/cleanup", async (c) => {
  setCookie(c, COOKIE_NAME, "", { expires: new Date() });
  setCookie(c, COOKIE_COPY_TEMPLATE_ID, "", { expires: new Date() });
  setCookie(c, COOKIE_INVITE_ID, "", { expires: new Date() });

  return c.json({ status: "ok" }, 200);
});

/**
 * Allow CORS preflight requests
 */
endpoints.options("*", (c) => {
  return c.text("ok", 200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS, DELETE, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
});

// middleware ////////////////////////////////////////////////////////////

endpoints.use(
  "*",
  createMiddleware(async (c, next) => {
    if (c.req.url.startsWith("/.well-known/")) return next(); // skip CORS for well-known endpoints

    const params = await requestToParams(c.req.raw);

    const { clientID, copyID, inviteID } = params;
    console.log({
      cookies: { clientID, copyID, inviteID },
      url: c.req.raw.url,
    });

    c.set("params", params);
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

    c.header("Access-Control-Allow-Origin", "*");
    c.header(
      "Access-Control-Allow-Methods",
      "GET, PATCH, OPTIONS, DELETE, POST",
    );
    c.header("Access-Control-Allow-Credentials", "true");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Cookie",
    );

    if (c.req.method === "OPTIONS") return;
    c.header(
      "Access-Control-Allow-Origin",
      c.get("project")?.originURL || c.env.WEBUI_ORIGIN_URL,
    );
    return;
  }),
);

type Params = {
  clientID: string | null;
  copyID: string | null;
  inviteID: string | null;
  url: URL;
};
async function requestToParams(request: Request): Promise<Params> {
  const url = new URL(request.url);

  const cookies = getCookiesFromRequest(request);

  const clientIDParams = url.searchParams.get("client_id")?.toString() || null;
  const copyIDParams = url.searchParams.get("copy_id")?.toString() || null;
  const inviteID = url.searchParams.get("invite_id")?.toString() || null;

  log(
    `Parsed params - clientIDParams: ${clientIDParams}, cookies: ${JSON.stringify(
      cookies,
    )}`,
  );

  return {
    url,
    clientID: clientIDParams || cookies[COOKIE_NAME] || null,
    copyID: copyIDParams || cookies[COOKIE_COPY_TEMPLATE_ID] || null,
    inviteID: inviteID || cookies[COOKIE_INVITE_ID] || null,
  };
}

// Endpoints /////////////////////////////////////////////////////////////

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
      await ensureSecret(
        getSecretFromRequest(c.req.raw),
        clientID,
        c.env.AUTH_DB,
      );
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
      await ensureSecret(
        getSecretFromRequest(c.req.raw),
        clientID,
        c.env.AUTH_DB,
      );
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
      await ensureSecret(
        getSecretFromRequest(c.req.raw),
        clientID,
        c.env.AUTH_DB,
      );
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
    await ensureSecret(
      getSecretFromRequest(c.req.raw),
      clientID,
      c.env.AUTH_DB,
    );

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
endpoints
  .get("/session/public/:clientID", async (c) => {
    const token = getTokenFromRequest(c.req.raw);
    try {
      const userInfo = await ensureToken({
        token,
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

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
      const userInfo = await ensureToken({
        token: getTokenFromRequest(c.req.raw),
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

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
      const userInfo = await ensureToken({
        token: getTokenFromRequest(c.req.raw),
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

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
endpoints
  .get("/session/private/:clientID", async (c) => {
    const token = getTokenFromRequest(c.req.raw);
    const secret = getSecretFromRequest(c.req.raw);
    try {
      await ensureSecret(secret, c.req.param("clientID"), c.env.AUTH_DB);
      const userInfo = await ensureToken({
        token,
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

      const responseData = await getUserPrivateData({
        userID: userInfo.id,
        clientID: userInfo.clientID,
        env: c.env,
      });

      if (!responseData.success) {
        throw new RequestError({
          message: responseData.error || "Failed to fetch user data",
          status: 400,
          project: c.get("project"),
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
    const token = getTokenFromRequest(c.req.raw);
    const secret = getSecretFromRequest(c.req.raw);
    try {
      await ensureSecret(secret, c.req.param("clientID"), c.env.AUTH_DB);
      const userInfo = await ensureToken({
        token,
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

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
    const token = getTokenFromRequest(c.req.raw);
    const secret = getSecretFromRequest(c.req.raw);
    try {
      await ensureSecret(secret, c.req.param("clientID"), c.env.AUTH_DB);
      const userInfo = await ensureToken({
        token,
        clientID: c.req.param("clientID"),
        env: c.env,
        ctx: c.executionCtx,
      });

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
    if (c.req.url.startsWith("/.well-known/")) return next(); // skip CORS for well-known endpoints
    const params: Params = c.get("params");

    if (!params.clientID) {
      return c.json({ error: "Unauthorized: Missing client ID" }, 401);
    }

    const project = c.get("project") as Project | undefined;
    if (!project) {
      return c.json(
        {
          error: `Invalid client_id or project not found, (client_id: ${params.clientID})`,
        },
        401,
      );
    }
    return next();
  }),
);

// Auth endpoints /////////////////////////////////////////////////

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

endpoints.all("*", async (c) => {
  const params: Params = c.get("params");
  const project: Project = c.get("project");
  return await issuer({
    storage: D1Storage({
      database: c.env.AUTH_DB,
      table: params.clientID!,
    }),
    subjects,
    providers: await generateProvidersFromConfig({
      project: project!,
      env: c.env,
      copyTemplateId: params.copyID,
    }),
    theme: await getThemeFromProject(project!, c.env),
    success: async (ctx, value, request) => {
      console.log(`Successful authentication with value: `, value);

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
        id: userData.id,
        data: userData.data,
        clientID: params.clientID!,
        provider: value.provider,
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
  }).fetch(c.req.raw, c.env, c.executionCtx);
});

// Auth helper functions //////////////////////////////////////////////////////

const currentProjectCache = new Map<string, Project>();
async function getProjectById(
  clientId: string,
  env: Env,
): Promise<null | Project> {
  if (clientId === PUBLIC_CLIENT_ID) {
    return {
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

  if (currentProjectCache.has(clientId)) {
    return currentProjectCache.get(clientId)!;
  }

  const projectData = await drizzle(env.AUTH_DB)
    .select()
    .from(projectTable)
    .where(eq(projectTable.clientID, clientId))
    .get();

  if (!projectData) {
    return null;
  }

  const project = parseDBProject(projectData);
  currentProjectCache.set(clientId, project);
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
  return Boolean(
    await drizzle(env.AUTH_DB)
      .select()
      .from(usersTable)
      .where(eq(usersTable.identifier, identifier))
      .limit(1)
      .get(),
  );
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
  ctx: Context<{
    Bindings: Env;
    Variables: { params: Params; project: Project };
  }>;
}): Promise<userExtractResult<{}> & { id: string }> {
  const usersTable = OTFusersTable(project.clientID);
  const userData = await providerConfigMap[
    value.provider as keyof typeof providerConfigMap
  ].parser(value, providerConfig);

  if (
    project.registerOnInvite &&
    !(await userExists(env, userData.identifier, project.clientID))
  ) {
    if (!params.inviteID)
      throw new Error("Invite ID is required for registration on invite");
    await ensureInviteLinkIsValid(params.inviteID, env).catch((error) => {
      log(
        `Error validating invite link for invite_id: ${params.inviteID}, error: ${
          (error as Error).message
        }`,
      );
      setCookie(ctx, COOKIE_INVITE_ID, "", {
        expires: new Date(),
      });
      throw new RequestError({
        message: `Invalid invite link: ${(error as Error).message}`,
        status: 401,
        project,
        params,
        request: ctx.req.raw,
      });
    });
  }

  const dataToStore = { ...userData.data, provider: value.provider };
  const result = (
    await drizzle(env.AUTH_DB)
      .insert(usersTable)
      .values({
        id: crypto.randomUUID() + crypto.randomUUID(),
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
      .returning({ id: usersTable.id })
  ).at(0);

  if (!result) {
    throw new Error(`Unable to process user: ${JSON.stringify(userData)}`);
  }
  log(
    `Found or created user ${result.id} with data ${JSON.stringify(userData.data)}`,
  );

  await removeInviteLinkById(params.inviteID!, env)
    .then(() => setCookie(ctx, COOKIE_INVITE_ID, "", { maxAge: -1 }))
    .catch((error) => {
      log(
        `Error removing invite link for invite_id: ${params.inviteID}, error: ${
          (error as Error).message
        }`,
      );
      return insertLog({
        type: "warning",
        clientID: params.clientID!,
        message: `Failed to remove invite link with id ${params.inviteID} after use: ${(error as Error).message}`,
        database: env.AUTH_DB,
        endpoint: "getOrCreateUser in invite flow",
      });
    });

  return { ...userData, id: result.id };
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

function getTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function getSecretFromRequest(request: Request): string | null {
  const header = request.headers.get("X-Client-Secret");
  if (!header) {
    return null;
  }
  return header.trim();
}

/**
 * ensure secret is present and valid for the given projectID
 * @throws {RequestError} if secret is missing or invalid
 * @returns the subject properties from the token if valid
 */
async function ensureSecret(
  secret: string | null,
  projectID: string,
  database: D1Database,
): Promise<string> {
  if (!secret) {
    throw new PartialRequestError("Unauthorized: Missing secret", 401);
  }
  const project = await drizzle(database)
    .select({
      secret: projectTable.secret,
    })
    .from(projectTable)
    .where(
      and(
        eq(projectTable.clientID, projectID),
        eq(projectTable.secret, secret),
      ),
    )
    .get();

  if (typeof project === "undefined") {
    throw new PartialRequestError("Unauthorized: Invalid secret", 401);
  }
  return project.secret;
}

async function ensureToken({
  token,
  clientID,
  env,
  ctx,
}: {
  token: string | null;
  clientID: string;
  env: Env;
  ctx: ExecutionContext;
}) {
  if (!token) {
    throw new PartialRequestError("Unauthorized: Missing token", 401);
  }
  const selfClient = createSelfClient({
    env,
    ctx,
    clientID,
  });

  console.log({ selfClient, token, subjects });

  const verified = await selfClient.verify(subjects, token);
  if (verified.err) {
    throw new PartialRequestError("Unauthorized: Invalid token", 401);
  }
  return verified.subject.properties;
}

function createSelfClient({
  env,
  ctx,
  clientID,
}: {
  env: Env;
  ctx: ExecutionContext;
  clientID: string;
}) {
  return createClient({
    clientID,
    issuer: env.ISSUER_URL,
    async fetch(input, init) {
      const url = new URL(input);
      url.searchParams.append("client_id", clientID);
      return Issuer.fetch(new Request(url.toString(), init), env, ctx);
    },
  });
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
