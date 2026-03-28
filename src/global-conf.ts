import type { OnSuccessResponder } from "@kagii/openauth/issuer";
import type { Prettify } from "@kagii/openauth/util";
import type { authCodeType } from "openauth-webui-shared-types";

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
		 * Called after a successful authentication (registration or login) occurs. You can use this to perform additional actions, such as logging, updating user data, etc. If it returns { success: false }, the authentication will be considered unsuccessful and the user will not be logged in.
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

export type CustomEGCPCProps = {
	/**
	 * destination address (email or phone number depending on the context)
	 */
	to: string;
	/**
	 * the code that was generated for the user, so they can use it to authenticate
	 */
	code: string;
	/**
	 * the body of the (email or SMS) to be sent
	 */
	body: string;
	/**
	 * subject of the email (only for email, ignored for SMS)
	 */
	subject: string;
	/**
	 * the subject of the email (only applicable for email, ignored for SMS)
	 */
	type: authCodeType;
};

export type EGPCEmail =
	| {
			provider: "resend";
			apiKey: string;
			emailFrom: string;
	  }
	| {
			provider: "custom";
			sendEmailFunction: (props: CustomEGCPCProps) => Promise<void> | void;
	  };

export type EGPCPhone =
	| {
			provider: "twilio";
			accountSID: string;
			authToken: string;
			fromNumber: string;
	  }
	| {
			provider: "custom";
			sendSMSFunction: (props: CustomEGCPCProps) => Promise<void> | void;
	  };
