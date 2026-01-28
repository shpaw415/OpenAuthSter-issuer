import { issuer } from "@openauthjs/openauth";
import { D1Storage } from "./db/d1-adapter";

import { COOKIE_NAME, createCookieContent } from "./share";
import { parseDBProject, Project } from "openauth-webui-shared-types";

import DefaultTheme from "./defaults/theme";
import {
  OTFusersTable,
  projectTable,
  uiStyleTable,
} from "openauth-webui-shared-types/database";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";
import { Theme } from "@openauthjs/openauth/ui/theme";
import { subjects } from "../openauth.config";
import packageJson from "../package.json" assert { type: "json" };
import { generateProvidersFromConfig } from "./providers-setup";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const utilityResponse = UtilityResponse(request);
    if (utilityResponse) {
      return utilityResponse;
    }
    const url = new URL(request.url);
    const headers = new Headers();
    const client_id =
      url.searchParams.get("client_id") || getClientIdFromCookies(request);

    if (!client_id) return new Response("Missing client_id", { status: 400 });
    else if (client_id)
      headers.append("Set-Cookie", createCookieContent(client_id));

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
      url.pathname.endsWith("/register")
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

    const copyTemplateId = request.headers.get("X-OpenAuth-Copy-ID");

    const res = await issuer({
      storage: D1Storage({
        database: env.AUTH_DB,
        table: client_id,
      }),
      subjects,
      providers: await generateProvidersFromConfig({
        project,
        env,
      }),
      theme: await getThemeFromProject(project, env),
      success: async (ctx, value) => {
        return ctx.subject("user", {
          id: await getOrCreateUser(env, value.email, client_id),
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

    return res;
  },
} satisfies ExportedHandler<Env>;

function getClientIdFromCookies(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === COOKIE_NAME) {
      return value;
    }
  }
  return null;
}

async function getOrCreateUser(
  env: Env,
  email: string,
  clientId: string,
): Promise<string> {
  const usersTable = OTFusersTable(clientId);
  const result = (
    await drizzle(env.AUTH_DB)
      .insert(usersTable)
      .values({
        email,
        id: crypto.randomUUID(),
        data: JSON.stringify({}),
        created_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        set: { email: email },
        target: usersTable.email,
      })
      .returning({ id: usersTable.id, data: usersTable.data })
  ).at(0);

  if (!result) {
    throw new Error(`Unable to process user: ${email}`);
  }
  console.log(`Found or created user ${result.id} with email ${email}`);
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
