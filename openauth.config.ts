import { type Project, PUBLIC_CLIENT_ID } from "openauth-webui-shared-types";
import { defaultSubjectSchema } from "openauth-webui-shared-types/client/user";
import type { InferOutput } from "valibot";
import type { EndpointCtx } from "./src/endpoints/types";
import { createExternalGlobalProjectConfig } from "./src/global-conf";

export default async (request_ctx: EndpointCtx, project: Project) =>
	createExternalGlobalProjectConfig<InferOutput<typeof subjects.user>>({
		register: {
			fallbackEmailFrom: request_ctx.env.EMAIL_FROM,
			onSuccessfulAuthentication(ctx, value) {
				console.log(ctx, value);
				if (
					project.clientID === PUBLIC_CLIENT_ID &&
					!request_ctx.env.WEBUI_ADMIN_EMAILS.split(",").includes(
						value.email as string,
					)
				) {
					return {
						success: false,
						error: new Error(
							"Email is not authorized to access this application",
						),
					};
				}
				return {
					success: true,
				};
			},
			strategy: {
				email: {
					provider: "resend",
					apiKey: request_ctx.env.RESEND_API_KEY,
					emailFrom: request_ctx.env.EMAIL_FROM,
				},
			},
		},
	});

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.
export const subjects = defaultSubjectSchema;
