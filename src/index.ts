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
	if (env.LOG_ENABLED === "true") globalThis.isLog = true;
	endpoints.onError(async (error, c) => {
		if (error instanceof RequestError) {
			const clientID = c.get("project")?.clientID;
			if (clientID)
				await insertLog({
					clientID: clientID,
					type: "error",
					message: error.message,
					database: env.AUTH_DB,
					endpoint: error.endpoint,
					context: {
						params: error.params || null,
						stack: error.stack,
						request: {
							headers: Object.fromEntries(
								Array.from(request.headers.entries()).filter(
									([key]) => key.toLowerCase() !== "authorization",
								),
							),
						},
						response: { status: error.status },
						token: error.token || null,
						secret: error.secret || null,
					},
				});
			return c.text(error.message, { status: error.status });
		} else if (error instanceof PartialRequestError) {
			const clientID = c.get("project")?.clientID;
			if (clientID)
				await insertLog({
					clientID: clientID,
					type: "error",
					message: error.message,
					database: env.AUTH_DB,
					endpoint: new URL(c.req.url).pathname,
					context: {
						params: c.get("params") || null,
						stack: error.stack,
						request: {
							headers: Object.fromEntries(
								Array.from(request.headers.entries()).filter(
									([key]) => key.toLowerCase() !== "authorization",
								),
							),
						},
						response: { status: error.status },
					},
				});
			return c.text(error.message, { status: error.status });
		} else {
			log(`Unexpected error in endpoint handler: ${(error as Error).message}`, {
				stack: (error as Error).stack,
			});
			const clientID = c.get("project")?.clientID;
			if (clientID)
				await insertLog({
					clientID: clientID,
					type: "error",
					message: (error as Error).message,
					database: env.AUTH_DB,
					endpoint: new URL(c.req.url).pathname,
				});

			return c.text("Internal Server Error", { status: 500 });
		}
	});

	return await endpoints.fetch(request, env, ctx);
}

export default {
	fetch: _fetch,
} satisfies ExportedHandler<Env>;
