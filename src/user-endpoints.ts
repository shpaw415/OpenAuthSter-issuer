import { createClient } from "@openauthjs/openauth/client";
import { drizzle, eq } from "openauth-webui-shared-types/drizzle";
import { OTFusersTable } from "openauth-webui-shared-types/database";
import { subjects } from "../openauth.config";
import { COOKIE_NAME, Project } from "openauth-webui-shared-types";
import { parse } from "valibot";
import {
  ResponseData,
  UserEndpointResponseValidation,
  UserEndpointValidation,
} from "openauth-webui-shared-types/client/user";
import Issuer from ".";
import { log } from "./share";

export default async function userEndPoint({
  request,
  env,
  ctx,
  project,
}: {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  project: Project;
}): Promise<Response> {
  const accessToken = getTokenFromRequest(request);

  if (!accessToken) {
    return new Response("Unauthorized: Missing Token", { status: 401 });
  }

  let data = parse(
    UserEndpointValidation,
    Object.fromEntries((await request.formData()).entries()),
  );

  data.data = data.data ? JSON.parse(data.data as string) : undefined;

  const client = createSelfClient({ env, ctx, clientID: data.client_id });

  const verified = await client.verify(subjects, accessToken);
  if (verified.err) {
    return new Response("Unauthorized: Invalid Token", { status: 401 });
  }

  if (data.action === "get") {
    if (data.type === "public") {
      const publicData = await getUserPublicData(
        verified.subject.properties.id,
        data.client_id,
        env,
      );
      return Response.json(parse(UserEndpointResponseValidation, publicData));
    } else if (data.type === "private") {
      const secret = getSecretFromRequest(request);
      if (!secret) {
        return new Response("Unauthorized: Missing Client Secret", {
          status: 401,
        });
      }
      const privateData = await getUserPrivateData({
        userID: verified.subject.properties.id,
        clientID: data.client_id,
        env,
        secret,
        projectSecret: project.secret,
      });
      return Response.json(parse(UserEndpointResponseValidation, privateData));
    }
  } else if (data.action == "update") {
    if (data.type === "public") {
      const updatedData = await updateUserPublicData({
        userID: verified.subject.properties.id,
        clientID: data.client_id,
        env,
        newData: data.data,
      });
      return Response.json(updatedData);
    } else if (data.type === "private") {
      const secret = getSecretFromRequest(request);
      if (!secret) {
        return new Response("Unauthorized: Missing Client Secret", {
          status: 401,
        });
      }
      const updatedData = await updateUserPrivateData({
        userID: verified.subject.properties.id,
        clientID: data.client_id,
        env,
        newData: data.data,
        secret,
        projectSecret: project.secret,
      });
      return Response.json(updatedData);
    }
  }

  return new Response("Bad Request", { status: 400 });
}

async function updateUserPrivateData({
  userID,
  clientID,
  env,
  newData,
  secret,
  projectSecret,
}: {
  userID: string;
  clientID: string;
  env: Env;
  newData: any;
  secret: string;
  projectSecret: string;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);
  const currentData = await getUserPrivateData({
    userID,
    clientID,
    env,
    secret,
    projectSecret,
  });
  if (!currentData.success) {
    return currentData;
  }
  const mergedData = {
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
        },
      };
    });
}

async function updateUserPublicData({
  userID,
  clientID,
  env,
  newData,
}: {
  userID: string;
  clientID: string;
  env: Env;
  newData: any;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);
  const currentData = await getUserPublicData(userID, clientID, env);
  if (!currentData.success) {
    return {
      success: false,
      error: "User not found",
    };
  }
  const mergedData: Record<string, any> = {
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
        },
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

async function getUserPrivateData({
  userID,
  clientID,
  env,
  secret,
  projectSecret,
}: {
  userID: string;
  clientID: string;
  env: Env;
  secret: string;
  projectSecret: string;
}): Promise<ResponseData> {
  const usersTable = OTFusersTable(clientID);

  if (!(await isSecretValid(secret, projectSecret))) {
    return {
      success: false,
      error: "Invalid secret",
    };
  }

  return drizzle(env.AUTH_DB)
    .select({
      private: usersTable.session_private,
      public: usersTable.session_public,
      id: usersTable.id,
      identifier: usersTable.identifier,
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
        },
        success: true,
      };
    });
}

async function isSecretValid(secret: string, projectSecret: string) {
  return secret === projectSecret;
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
      const header = new Headers(init?.headers);
      header.append("cookie", `${COOKIE_NAME}=${clientID}`);
      log(
        `Fetching with clientID ${clientID} headers:`,
        Array.from(header.entries()),
      );
      const req = new Request(input, { ...init, headers: header });
      return Issuer.fetch(req, env, ctx);
    },
  });
}
