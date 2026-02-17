import { log } from "./share";
import { insertLog } from "openauth-webui-shared-types/database";
import { endpoints, RequestError } from "./endpoints";

declare global {
  var isLog: boolean;
}

globalThis.isLog ??= false;

async function _fetch(request: Request, env: Env, ctx: ExecutionContext) {
  //@ts-ignore
  if (env.LOG_ENABLED == "true") globalThis.isLog = true;
  try {
    return await endpoints.fetch(request, env, ctx);
  } catch (error) {
    if (error instanceof RequestError) {
      await insertLog({
        clientID: error.params?.clientID || "unknown",
        type: "error",
        message: error.message,
        database: env.AUTH_DB,
        endpoint: error.endpoint || "unknown",
        context: {
          params: error.params || null,
          stack: error.stack,
          request: { headers: Object.fromEntries(request.headers.entries()) },
          response: { status: error.status },
        },
      });

      if (error.response) {
        return new Response(error.response.body, {
          ...error.response.init,
          status: error.status,
        });
      }

      return new Response(error.message, { status: error.status });
    }

    log(`Unexpected error in fetch handler: ${(error as Error).message}`, {
      stack: (error as Error).stack,
    });
    return new Response("Internal Server Error", { status: 500 });
  }
}

export default {
  fetch: _fetch,
} satisfies ExportedHandler<Env>;
