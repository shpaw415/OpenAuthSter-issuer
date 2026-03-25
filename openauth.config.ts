import {
	createExternalGlobalProjectConfig,
	type Project,
} from "openauth-webui-shared-types";
import { defaultSubjectSchema } from "openauth-webui-shared-types/client/user";
import type { InferOutput } from "valibot";
import type { EndpointCtx } from "./src/endpoints/types";

export default async (_ctx: EndpointCtx, _project: Project) =>
	createExternalGlobalProjectConfig<InferOutput<typeof subjects.user>>({
		register: {
			fallbackEmailFrom: "fallback@example.com",
			onSuccessfulRegistration(_ctx, _value, _request) {
				//console.log(ctx, value);
			},
			strategy: {
				email: {
					provider: "custom",
					sendEmailFunction(to, code) {
						console.log(`Send code ${code} to email ${to}`);
					},
				},
			},
		},
	});

// This value should be shared between the OpenAuth server Worker and other
// client Workers that you connect to it, so the types and schema validation are
// consistent.
export const subjects = defaultSubjectSchema;
