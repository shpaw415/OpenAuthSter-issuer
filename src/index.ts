import { insertLog } from "openauth-webui-shared-types/database";
import { endpoints } from "./endpoints";
import { PartialRequestError, RequestError } from "./endpoints/error";
import { log } from "./share";

export { QRHandshake } from "openauth-webui-shared-types/providers/custom/DurableObject.ts";

declare global {
	var isLog: boolean;
}

globalThis.isLog ??= false;

async function _fetch(request: Request, env: Env, ctx: ExecutionContext) {
	//@ts-expect-error
	if (env.LOG_ENABLED === "true") globalThis.isLog = true;
	try {
		return await endpoints.fetch(request, env, ctx);
	} catch (error) {
		if (error instanceof PartialRequestError) {
			log(`PartialRequestError: ${error.message}, status: ${error.status}`);
			return new Response(error.message, { status: error.status });
		}

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
					token: error.token || null,
					secret: error.secret || null,
				},
			});

			if (error.response) {
				return new Response((error.response.body as string) ?? "Error", {
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
