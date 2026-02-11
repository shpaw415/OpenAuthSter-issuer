import { issuer } from "@openauthjs/openauth";
import { D1Storage } from "./db/d1-adapter";

import {
  createClientIdCookieContent,
  createCopyIdCookieContent,
  createInviteIdCookieContent,
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
import { ensureInviteLinkIsValid, removeInviteLinkById } from "./invite-link";

class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Params = {
  clientID: string | null;
  copyID: string | null;
  inviteID: string | null;
  url: URL;
};
class RequestManager {
  public request: Request;
  public header: Headers;
  public response: Response | null = null;
  public params: Params = null as any;
  public env: Env;
  public ctx: ExecutionContext;

  constructor(request: Request, env: Env, ctx: ExecutionContext) {
    this.request = request;
    this.header = new Headers();
    this.env = env;
    this.ctx = ctx;
  }

  public UtilityResponse() {
    const url = new URL(this.request.url);
    switch (url.pathname) {
      case "/health":
        this.setResponse(new Response("OK"));
      case "/version":
        this.setResponse(new Response(packageJson.version));
      case "/user-endpoint":
        if (this.request.method !== "OPTIONS") break;
        this.setResponse(
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          }),
        );
    }
    return Boolean(this.response);
  }

  public before() {
    const { clientID, copyID, inviteID } = this.params;
    console.log({
      cookies: { clientID, copyID, inviteID },
      url: this.request.url,
    });
    if (clientID || copyID) {
      this.header.append("Set-Cookie", createClientIdCookieContent(clientID!));
    }
    if (copyID) {
      this.header.append("Set-Cookie", createCopyIdCookieContent(copyID));
    }
    if (inviteID) {
      this.header.append("Set-Cookie", createInviteIdCookieContent(inviteID));
    }
  }

  public setResponse(response: Response) {
    if (this.response) return this;
    this.response = response;
    return this;
  }

  public prepare({ project, env }: { project: Project | null; env: Env }) {
    if (!this.response) return this;

    this.header.forEach((value, key) => {
      this.response!.headers.append(key, value);
    });

    this.response.headers.set(
      "Access-Control-Allow-Origin",
      project?.originURL || env.WEBUI_ORIGIN_URL,
    );

    return this;
  }

  public getResponse(): Response {
    if (!this.response) {
      return new Response("Not Found", { status: 404 });
    }
    return this.response;
  }

  public async init() {
    this.header.set("Access-Control-Allow-Credentials", "true");
    this.header.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    this.header.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    this.header.set("Vary", "Origin, Cookie");
    this.header.set("Access-Control-Allow-Origin", "*");
    this.params = await this.requestToParams();
    this.before();
  }

  public ensureSet<T>(check: T, message: string, status: number) {
    if (check) return check;
    throw new RequestError(message, status);
  }

  public async handleWebUIRegister() {
    if (
      this.params.clientID === "openauth_webui" &&
      this.request.method === "POST" &&
      this.params.url.pathname.endsWith("/register")
    ) {
      const formData = await this.request.clone().formData();
      const email = formData.get("email")?.toString().trim();
      if (
        email &&
        !this.env.WEBUI_ADMIN_EMAILS.split(",").some((e) => e.trim() === email)
      ) {
        throw new RequestError(
          "Unauthorized: Email not allowed for registration",
          401,
        );
      }
    }
  }

  public removeParamCookie(name: "client_id" | "copy_id" | "invite_id") {
    switch (name) {
      case "client_id":
        this.header.append(
          "Set-Cookie",
          createClientIdCookieContent("", { maxAge: 0 }),
        );
        break;
      case "copy_id":
        this.header.append(
          "Set-Cookie",
          createCopyIdCookieContent("", { maxAge: 0 }),
        );
        break;
      case "invite_id":
        this.header.append(
          "Set-Cookie",
          createInviteIdCookieContent("", { maxAge: 0 }),
        );
        break;
    }
  }

  public removeAllParamCookies() {
    (["client_id", "copy_id", "invite_id"] as const).forEach(
      this.removeParamCookie,
    );
  }

  public async handleUserEndpoints(project: Project) {
    if (this.params.url.pathname.startsWith("/user-endpoint")) {
      this.setResponse(
        await UserEndpoints({
          request: this.request,
          env: this.env,
          ctx: this.ctx,
          project,
        }),
      );
    }
  }

  private async requestToParams(): Promise<Params> {
    const url = new URL(this.request.url);

    const cookies = getCookiesFromRequest(this.request);

    const clientIDParams = url.searchParams.get("client_id")?.split("::") as
      | [string, string | null]
      | null;
    const inviteID = url.searchParams.get("invite_id")?.toString() || null;
    const formData =
      this.request.method === "POST"
        ? await this.request.clone().formData()
        : null;
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
}

async function _fetch(request: Request, env: Env, ctx: ExecutionContext) {
  let project: Project | null = null;
  const manager = new RequestManager(request, env, ctx);
  try {
    if (manager.UtilityResponse()) return manager.getResponse();

    await manager.init();
    const {
      clientID: client_id,
      copyID: copyTemplateId,
      inviteID,
    } = manager.params;

    log(
      `Incoming request for client_id: ${client_id}, copyTemplateId: ${copyTemplateId}, inviteID: ${inviteID}, url: ${manager.params.url.href}, method: ${request.method}`,
    );
    manager.ensureSet(client_id, "Missing client_id", 400);

    project = await getProjectById(client_id!, env);
    manager.ensureSet(
      project,
      `Invalid client_id or project not found, (client_id: ${client_id})`,
      400,
    );

    await manager.handleWebUIRegister();
    await manager.handleUserEndpoints(project!);

    return manager
      .setResponse(
        await issuer({
          storage: D1Storage({
            database: env.AUTH_DB,
            table: client_id!,
          }),
          subjects,
          providers: await generateProvidersFromConfig({
            project: project!,
            env,
            copyTemplateId,
          }),
          theme: await getThemeFromProject(project!, env),
          success: async (ctx, value, request) => {
            console.log(`Successful authentication with value: `, value);

            await (
              await globalOpenAutsterConfig(env)
            ).register.onSuccessfulRegistration?.(ctx, value, request);

            const userData = await getOrCreateUser({
              env,
              value,
              manager: manager,
              providerConfig: project?.providers_data.find(
                (p) => p.type === value.provider,
              ) as ProviderConfig,
              project: project!,
            });

            return ctx.subject("user", {
              id: userData.id,
              data: userData.data,
              clientID: client_id!,
              provider: value.provider,
            });
          },
          async error(error, req) {
            console.error(`Error during authentication for ${req.url}:`, error);
            console.log(req);
            throw new Error(
              `Authentication error: ${(error as Error).message}`,
            );
          },
        }).fetch(request, env, ctx),
      )
      .prepare({
        project,
        env,
      })
      .getResponse();
  } catch (error) {
    log(`Unexpected error in fetch handler: ${(error as Error).message}`, {
      stack: (error as Error).stack,
    });
    await insertLog({
      clientID: manager.params?.clientID || "unknown",
      type: "error",
      message: `Unexpected error in fetch handler: ${(error as Error).message}`,
      database: env.AUTH_DB,
      endpoint: "fetch handler",
      context: {
        params: manager.params,
        stack: (error as Error).stack,
        headers: Object.fromEntries(manager.header.entries()),
      },
    });

    if (error instanceof RequestError) {
      manager.setResponse(
        new Response(error.message, { status: error.status }),
      );
      return manager
        .prepare({
          project: project,
          env,
        })
        .getResponse();
    }

    return new Response("Internal Server Error", { status: 500 });
  }
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
  providerConfig,
  project,
  manager,
}: {
  env: Env;
  value: Record<string, any>;
  providerConfig: ProviderConfig;
  project: Project;
  manager: RequestManager;
}): Promise<userExtractResult<{}> & { id: string }> {
  const usersTable = OTFusersTable(manager.params.clientID!);
  const userData = await providerConfigMap[
    value.provider as keyof typeof providerConfigMap
  ].parser(value, providerConfig);

  if (project.registerOnInvite) {
    if (!manager.params.inviteID)
      throw new Error("Invite ID is required for registration on invite");
    await ensureInviteLinkIsValid(manager.params.inviteID, env).catch(
      (error) => {
        log(
          `Error validating invite link for invite_id: ${manager.params.inviteID}, error: ${
            (error as Error).message
          }`,
        );
        manager.removeParamCookie("invite_id");
        throw new RequestError(
          `Invalid invite link: ${(error as Error).message}`,
          401,
        );
      },
    );
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

  await removeInviteLinkById(manager.params.inviteID!, env)
    .then(() => manager.removeParamCookie("invite_id"))
    .catch((error) => {
      log(
        `Error removing invite link for invite_id: ${manager.params.inviteID}, error: ${
          (error as Error).message
        }`,
      );
      return insertLog({
        type: "warning",
        clientID: manager.params.clientID!,
        message: `Failed to remove invite link with id ${manager.params.inviteID} after use: ${(error as Error).message}`,
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
