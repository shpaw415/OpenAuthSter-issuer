import { issuer } from "@openauthjs/openauth";
import { D1Storage } from "./db/d1-adapter";

import {
  createClientIdCookieContent,
  createCopyIdCookieContent,
  log,
} from "./share";
import {
  parseDBProject,
  Project,
  COOKIE_COPY_TEMPLATE_ID,
  COOKIE_NAME,
  ProviderConfig,
  COOKIE_INVITE_ID,
} from "openauth-webui-shared-types";

import DefaultTheme from "./defaults/theme";
import {
  insertLog,
  OTFusersTable,
  projectTable,
  uiStyleTable,
} from "openauth-webui-shared-types/database";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";
import { Theme } from "@openauthjs/openauth/ui/theme";
import globalOpenAutsterConfig, { subjects } from "../openauth.config";
import packageJson from "../package.json" assert { type: "json" };
import {
  generateProvidersFromConfig,
  providerConfigMap,
  userExtractResult,
} from "./providers-setup";
import UserEndpoints from "./user-endpoints";
import {
  ensureInviteLinkIsValid,
  removeInviteLinkById,
  createResponseFromInviteId,
} from "./invite-link";

async function _fetch(request: Request, env: Env, ctx: ExecutionContext) {
  const utilityResponse = UtilityResponse(request);
  if (utilityResponse) {
    return utilityResponse;
  }

  const params = await requestToParams(request);
  const client_id = params.clientID;
  const copyTemplateId = params.copyID;

  log(
    `Incoming request for client_id: ${client_id}, copyTemplateId: ${copyTemplateId}, url: ${params.url.href}, method: ${request.method}`,
  );

  const headers = new Headers();

  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin, Cookie");
  headers.set("Access-Control-Allow-Origin", "*");

  if (!client_id) return new Response("Missing client_id", { status: 400 });
  else if (client_id || copyTemplateId)
    headers.append("Set-Cookie", createClientIdCookieContent(client_id));
  if (copyTemplateId)
    headers.append("Set-Cookie", createCopyIdCookieContent(copyTemplateId));

  const project = await getProjectById(client_id, env);
  if (!project) {
    log(`Project not found for client_id: ${client_id}`);
    return Response.json(
      {
        error: `Invalid client_id or project not found, (client_id: ${client_id})`,
      },
      {
        status: 400,
        headers,
      },
    );
  }

  if (
    client_id === "openauth_webui" &&
    request.method === "POST" &&
    params.url.pathname.endsWith("/register")
  ) {
    const formData = await request.clone().formData();
    const email = formData.get("email")?.toString().trim();
    if (
      email &&
      !env.WEBUI_ADMIN_EMAILS.split(",").some((e) => e.trim() === email)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let res: Response;
  if (params.url.pathname.startsWith("/user-endpoint")) {
    res = await UserEndpoints({ request, env, ctx, project });
  } else if (params.url.pathname === "/invite") {
    if (!project.originURL)
      throw new Error(
        "Project origin URL is not set, cannot process invite link",
      );
    await createResponseFromInviteId({
      id: params.inviteID!,
      env,
      redirectURI: project.originURL,
      copyID: params.copyID,
    })
      .then((response) => {
        res = response;
      })
      .catch((error) => {
        log(
          `Error processing invite link for invite_id: ${params.inviteID}, error: ${
            (error as Error).message
          }`,
        );
        res = new Response(`Invalid invite link: ${(error as Error).message}`, {
          status: 400,
        });
      });
  }

  res ??= await issuer({
    storage: D1Storage({
      database: env.AUTH_DB,
      table: client_id,
    }),
    subjects,
    providers: await generateProvidersFromConfig({
      project,
      env,
      copyTemplateId,
    }),
    theme: await getThemeFromProject(project, env),
    success: async (ctx, value, request) => {
      console.log(`Successful authentication with value: `, value);

      await (
        await globalOpenAutsterConfig(env)
      ).register.onSuccessfulRegistration?.(ctx, value, request);

      const userData = await getOrCreateUser({
        env,
        value,
        clientId: client_id,
        providerConfig: project.providers_data.find(
          (p) => p.type === value.provider,
        ) as ProviderConfig,
        project,
        inviteID: params.inviteID || null,
      });

      return ctx.subject("user", {
        id: userData.id,
        data: userData.data,
        clientID: client_id,
        provider: value.provider,
      });
    },
    async error(error, req) {
      console.error(`Error during authentication for ${req.url}:`, error);
      console.log(req);
      return Response.json({ error: "Authentication error" }, { status: 500 });
    },
  }).fetch(request, env, ctx);

  headers.forEach((value, key) => {
    res.headers.append(key, value);
  });
  res.headers.set(
    "Access-Control-Allow-Origin",
    project.originURL || env.WEBUI_ORIGIN_URL,
  );

  return res;
}

export default {
  fetch: _fetch,
} satisfies ExportedHandler<Env>;

function getCookiesFromRequest(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("cookie");
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    const cookiePairs = cookieHeader.split(";");
    for (const pair of cookiePairs) {
      const [name, value] = pair.trim().split("=");
      cookies[name] = value;
    }
  }
  return cookies;
}

async function getOrCreateUser({
  env,
  value,
  clientId,
  providerConfig,
  project,
  inviteID,
}: {
  env: Env;
  value: Record<string, any>;
  clientId: string;
  providerConfig: ProviderConfig;
  project: Project;
  inviteID: string | null;
}): Promise<userExtractResult<{}> & { id: string }> {
  const usersTable = OTFusersTable(clientId);
  const userData = await providerConfigMap[
    value.provider as keyof typeof providerConfigMap
  ].parser(value, providerConfig);

  if (project.registerOnInvite) {
    if (!inviteID)
      throw new Error("Invite ID is required for registration on invite");
    await ensureInviteLinkIsValid(inviteID, env).catch((error) => {
      log(
        `Error validating invite link for invite_id: ${inviteID}, error: ${
          (error as Error).message
        }`,
      );
      throw new Error(`Invalid invite link: ${(error as Error).message}`);
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

  await removeInviteLinkById(inviteID!, env).catch((error) => {
    log(
      `Error removing invite link for invite_id: ${inviteID}, error: ${
        (error as Error).message
      }`,
    );
    return insertLog({
      type: "warning",
      clientID: clientId,
      message: `Failed to remove invite link with id ${inviteID} after use: ${(error as Error).message}`,
      database: env.AUTH_DB,
      endpoint: "getOrCreateUser in invite flow",
    });
  });

  return { ...userData, id: result.id };
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

async function getProjectById(
  clientId: string,
  env: Env,
): Promise<null | Project> {
  const projectData = await drizzle(env.AUTH_DB)
    .select()
    .from(projectTable)
    .where(eq(projectTable.clientID, clientId))
    .limit(1)
    .get();

  if (!projectData && clientId === "openauth_webui") {
    return {
      active: true,
      clientID: "openauth_webui",
      created_at: new Date().toISOString(),
      codeMode: "email",
      registerOnInvite: false,
      secret: "",
      authEndpointURL: "",
      cloudflareDomaineID: "",
      providers_data: [
        {
          type: "password",
          enabled: true,
          data: {},
        },
      ],
    };
  }

  if (!projectData) {
    return null;
  }

  return parseDBProject(projectData);
}

type Params = {
  clientID: string | null;
  copyID: string | null;
  inviteID: string | null;
  url: URL;
};

async function requestToParams(request: Request): Promise<Params> {
  const url = new URL(request.url);

  const cookies = getCookiesFromRequest(request);

  const clientIDParams = url.searchParams.get("client_id")?.split("::") as
    | [string, string | null]
    | null;
  const inviteID = url.searchParams.get("invite_id")?.toString() || null;
  const formData =
    request.method === "POST" ? await request.clone().formData() : null;
  const clientIDParamsForm = formData
    ?.get("client_id")
    ?.toString()
    .split("::") as [string, string | null] | null;

  log(
    `Parsed params - clientIDParams: ${clientIDParams}, clientIDParamsForm: ${clientIDParamsForm}, cookies: ${JSON.stringify(
      cookies,
    )}`,
    formData,
  );

  return {
    clientID:
      clientIDParams?.[0] ||
      clientIDParamsForm?.[0] ||
      cookies[COOKIE_NAME] ||
      null,
    copyID:
      clientIDParams?.[1] ||
      clientIDParamsForm?.[1] ||
      cookies[COOKIE_COPY_TEMPLATE_ID] ||
      null,
    url,
    inviteID: inviteID || cookies[COOKIE_INVITE_ID] || null,
  };
}

// Endpoint Section ////////////////////////////////////////////////

function UtilityResponse(request: Request): Response | null {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/health":
      return new Response("OK");
    case "/version":
      return new Response(packageJson.version);
    case "/user-endpoint":
      if (request.method !== "OPTIONS") break;
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
  }
  return null;
}

// End Endpoint Section ////////////////////////////////////////////
