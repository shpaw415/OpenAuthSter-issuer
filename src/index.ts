import { issuer } from "@openauthjs/openauth";
import { D1Storage } from "./db/d1-adapter";

import {
  createClientIdCookieContent,
  createCopyIdCookieContent,
} from "./share";
import {
  parseDBProject,
  Project,
  COOKIE_COPY_TEMPLATE_ID,
  COOKIE_NAME,
} from "openauth-webui-shared-types";

import DefaultTheme from "./defaults/theme";
import {
  OTFusersTable,
  projectTable,
  uiStyleTable,
} from "openauth-webui-shared-types/database";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";
import { Theme } from "@openauthjs/openauth/ui/theme";
import globalOpenAutsterConfig, { subjects } from "../openauth.config";
import packageJson from "../package.json" assert { type: "json" };
import { generateProvidersFromConfig } from "./providers-setup";
import UserSetup from "./user-setup";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const utilityResponse = UtilityResponse(request);
    if (utilityResponse) {
      return utilityResponse;
    }

    const params = await requestToParams(request);
    const client_id = params.clientID;
    const copyTemplateId = params.copyID;

    const headers = new Headers();

    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (!client_id) return new Response("Missing client_id", { status: 400 });
    else if (client_id || copyTemplateId)
      headers.append("Set-Cookie", createClientIdCookieContent(client_id));
    if (copyTemplateId)
      headers.append("Set-Cookie", createCopyIdCookieContent(copyTemplateId));

    const project = await getProjectById(client_id, env);
    if (!project) {
      return Response.json(
        {
          error: `Invalid client_id or project not found, (clientID: ${client_id})`,
        },
        { status: 400 },
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

    const res = await issuer({
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

        return ctx.subject("user", {
          id: await getOrCreateUser(env, value, client_id),
          data: value,
        });
      },
      async error(error, req) {
        console.error(`Error during authentication for ${req.url}:`, error);
        console.log(req);
        return Response.json(
          { error: "Authentication error" },
          { status: 500 },
        );
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
  },
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

async function getOrCreateUser(
  env: Env,
  value: Record<string, any>,
  clientId: string,
): Promise<string> {
  const usersTable = OTFusersTable(clientId);
  const identifier = UserSetup.extractIdentifierFor[
    value.provider as keyof typeof UserSetup.extractIdentifierFor
  ](value as any);
  const result = (
    await drizzle(env.AUTH_DB)
      .insert(usersTable)
      .values({
        id: crypto.randomUUID() + crypto.randomUUID(),
        identifier,
        data: JSON.stringify(value),
        created_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: usersTable.identifier,
        set: {
          data: JSON.stringify(value),
        },
      })
      .returning({ id: usersTable.id })
  ).at(0);

  if (!result) {
    throw new Error(`Unable to process user: ${JSON.stringify(value)}`);
  }
  console.log(
    `Found or created user ${result.id} with data ${JSON.stringify(value)}`,
  );
  return result.id;
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

function UtilityResponse(request: Request): Response | null {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/health":
      return new Response("OK");
    case "/version":
      return new Response(packageJson.version);
  }
  return null;
}

type Params = {
  clientID: string | null;
  copyID: string | null;
  url: URL;
};

async function requestToParams(request: Request): Promise<Params> {
  const url = new URL(request.url);

  const cookies = getCookiesFromRequest(request);

  const clientIDParams = url.searchParams.get("client_id")?.split("::") as
    | [string, string | null]
    | null;

  const clientIDParamsForm =
    (url.pathname == "/token" &&
      ((await request.clone().formData())
        .get("client_id")
        ?.toString()
        .split("::") as [string, string | null])) ||
    null;

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
  };
}
