import { OnSuccessResponder } from "@kagii/openauth/issuer";
import { Prettify } from "@kagii/openauth/util";
import { EGPCEmail, EGPCPhone } from "openauth-webui-shared-types";

export function createExternalGlobalProjectConfig<CTXProperties = unknown>(
	config: ExternalGlobalProjectConfig<CTXProperties>,
): ExternalGlobalProjectConfig<CTXProperties> {
	return config;
}

type OnSuccessResponseType = {
	success: boolean;
	error?: Error;
};

// Global configuration for external integrations
export type ExternalGlobalProjectConfig<CTXProperties = unknown> = {
	register: {
		fallbackEmailFrom: string;
		/**
		 * Called after a successful authentication (registration or login) occurs. You can use this to perform additional actions, such as logging, updating user data, etc. If it returns false, the authentication will be considered unsuccessful and the user will not be logged in.
		 */
		onSuccessfulAuthentication?: (
			ctx: OnSuccessResponder<
				Prettify<{
					type: "user";
					properties: CTXProperties;
				}>
			>,
			value: Record<string, unknown>,
			request: Request,
			type: "register" | "login",
		) => Promise<OnSuccessResponseType> | OnSuccessResponseType;
		strategy: Partial<{
			email: EGPCEmail;
			phone: EGPCPhone;
		}>;
	};
};
