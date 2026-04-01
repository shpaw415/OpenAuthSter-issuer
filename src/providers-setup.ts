import { initWasm, inline as inlineCss } from "@css-inline/css-inline-wasm";
import cssInlineWasm from "@css-inline/css-inline-wasm/index_bg.wasm";
import type { Provider } from "@kagii/openauth/provider/provider";
import { PasswordUI } from "@kagii/openauth/ui/password";
import type { JWTPayload } from "jose";
import type {
	AppleOAuthProviderConfig,
	AppleOIDCProviderConfig,
	authCodeType,
	CodeProviderConfig,
	CognitoProviderConfig,
	EmailTemplateProps,
	GenericOAuthProviderConfig,
	GoogleProviderConfig,
	KeycloakProviderConfig,
	MicrosoftProviderConfig,
	OAuth2ProviderConfig,
	OIDCProviderConfig,
	PasswordProviderConfig,
	Project,
	ProviderConfig,
	ProviderType,
	QRProviderConfig,
	SlackProviderConfig,
} from "openauth-webui-shared-types";
import { parseDBCopyTemplate } from "openauth-webui-shared-types";
import {
	emailTemplatesTable,
	WebUiCopyTemplateTable,
} from "openauth-webui-shared-types/database";
import { and, drizzle, eq } from "openauth-webui-shared-types/drizzle";
import type { QRProviderOnSuccessData } from "openauth-webui-shared-types/providers/custom/qr/index.ts";
import { WebHook } from "openauth-webui-shared-types/webhook";
import getGlobalConfig from "../openauth.config";
import DefaultEmailTemplateBody from "./defaults/email";
import type { EndpointCtx } from "./endpoints/types.ts";
import type { ExternalGlobalProjectConfig } from "./global-conf.ts";
import { SandBox } from "./sandbox.mts";
import { toAuthorizeOrigin } from "./share.ts";

let _cssInlineReady: Promise<void> | null = null;
function ensureCssInline() {
	if (!_cssInlineReady) _cssInlineReady = initWasm(cssInlineWasm);
	return _cssInlineReady;
}

export type userExtractResult<T extends Record<string, unknown>> = {
	identifier: string;
	data?: T;
};
export type userExtractFunction<
	Input,
	Output extends Record<string, unknown>,
	ProviderConf extends ProviderConfig,
> = (
	data: Input,
	providerConfig: ProviderConf,
	env: Env,
	ctx: EndpointCtx,
) => userExtractResult<Output> | Promise<userExtractResult<Output>>;
export type OnSuccessParserData<T> = {
	identifier: string;
	data: T;
};

export type TokenSet = {
	access: string;
	refresh: string;
	expiry: number;
	raw: Record<string, unknown>;
};

export type TokenSetKey = {
	tokenset: TokenSet;
};

type ConfigType<
	ProviderConf extends ProviderConfig,
	Input extends Record<string, unknown>,
	Output extends Record<string, unknown>,
> = {
	provider: (props: {
		globalConfig: ExternalGlobalProjectConfig;
		providerConfig: ProviderConf;
		env: Env;
		project: Project;
		copyTemplate: ReturnType<typeof parseDBCopyTemplate> | undefined;
		ctx: EndpointCtx;
	}) => Promise<Provider> | Provider;
	parser: userExtractFunction<Input, Output, ProviderConf>;
};

const defaultEmailTemplateProps: EmailTemplateProps = {
	subject: "Your verification code",
	body: DefaultEmailTemplateBody,
	name: "default",
};

async function getEmailTemplate({
	env,
	id,
	project,
}: {
	env: Env;
	id?: number | null;
	project: Project;
}): Promise<EmailTemplateProps> {
	if (!id) return defaultEmailTemplateProps;

	return drizzle(env.AUTH_DB)
		.select({
			name: emailTemplatesTable.name,
			subject: emailTemplatesTable.subject,
			body: emailTemplatesTable.body,
		})
		.from(emailTemplatesTable)
		.where(
			and(
				eq(emailTemplatesTable.id, id),
				eq(emailTemplatesTable.owner_id, project.owner_id),
			),
		)
		.limit(1)
		.get()
		.then((el) =>
			el
				? {
						...el,
						body: el?.body || DefaultEmailTemplateBody,
					}
				: defaultEmailTemplateProps,
		);
}

async function sendCode({
	code,
	project,
	to,
	globalConfig,
	emailTemplate,
	type,
	send_type,
	ctx,
}: {
	code: string;
	project: Project;
	to: string;
	globalConfig: ExternalGlobalProjectConfig;
	emailTemplate: EmailTemplateProps;
	type: authCodeType;
	send_type: "email" | "phone";
	ctx: EndpointCtx;
}) {
	const mustache = (await import("mustache")).default;
	const body = mustache.render(
		emailTemplate.body,
		await parseEmailTemplateProps({
			...project.projectData,
			code,
			type,
			AcceptLanguage: ctx.req.raw.headers.get("accept-language") || "",
			to,
		}),
	);

	if (send_type === "email") {
		await ensureCssInline();
		await sendCodeWithEmail({
			code,
			project,
			to,
			globalConfig,
			emailTemplate,
			emailBody: inlineCss(body),
			type,
		});
	} else if (send_type === "phone") {
		await sendCodeWithSMS({
			code,
			project,
			to,
			globalConfig,
			smsBody: body,
			type,
		});
	}
}

async function sendCodeWithEmail({
	code,
	project,
	to,
	globalConfig,
	emailTemplate,
	emailBody,
	type,
}: {
	code: string;
	project: Project;
	to: string;
	globalConfig: ExternalGlobalProjectConfig;
	emailTemplate: EmailTemplateProps;
	emailBody: string;
	type: authCodeType;
}) {
	switch (globalConfig.register.strategy.email?.provider) {
		case "resend": {
			const apiKey = globalConfig.register.strategy.email.apiKey;
			const result = await new (await import("resend")).Resend(
				apiKey,
			).emails.send({
				from: `${project.projectData?.companyName || "Acme"} <${project.projectData?.emailFrom ?? globalConfig.register.strategy?.email?.emailFrom ?? globalConfig.register.fallbackEmailFrom}>`,
				to: [to],
				subject: emailTemplate.subject || "Your verification code",
				html: emailBody,
			});
			if (result.error) {
				console.error(`Failed to send email to ${to}:`, result.error);
				throw new Error(`Failed to send email: ${result.error.message}`);
			} else {
				console.log("resend success:", {
					data: result.data,
					headers: result.headers,
				});
			}

			break;
		}
		case "custom":
			await globalConfig.register.strategy.email.sendEmailFunction({
				to,
				code,
				body: emailBody,
				subject: emailTemplate.subject || "Your verification code",
				type,
			});
			break;
		// Add other strategies as needed
		default:
			console.log(`Sending code ${code} to ${to} via default method`);
	}
}
async function sendCodeWithSMS({
	code,
	to,
	globalConfig,
	smsBody,
	type,
}: {
	code: string;
	to: string;
	globalConfig: ExternalGlobalProjectConfig;
	smsBody: string;
	project: Project;
	type: authCodeType;
}) {
	switch (globalConfig.register.strategy.phone?.provider) {
		case "twilio": {
			const twilioConfig = globalConfig.register.strategy.phone;
			const res = await sendTwilioSMS({
				accountSid: twilioConfig.accountSID,
				authToken: twilioConfig.authToken,
				to,
				from: twilioConfig.fromNumber,
				body: smsBody,
			});
			console.log("Twilio SMS log:", res);
			break;
		}
		case "custom":
			await globalConfig.register.strategy.phone.sendSMSFunction({
				to,
				code,
				type,
				body: smsBody,
				subject: "",
			});
			break;
		default:
			console.log(`Sending code ${code} to ${to} via default SMS method`);
			break;
	}
}

export async function parseEmailTemplateProps(
	emailProps?: Record<string, string | string[] | undefined>,
): Promise<Record<string, unknown>> {
	if (!emailProps) return {};
	let _sandbox: SandBox | undefined;
	if (
		Object.values(emailProps).some(
			(v) => typeof v === "string" && v.startsWith("function::"),
		)
	)
		_sandbox = await SandBox.create();
	return Object.fromEntries(
		Object.entries(emailProps).map(([key, value]) => {
			if (!value) return [key, value];
			if (typeof value === "string" && value.startsWith("function::")) {
				const body = value.replace("function::", "");
				const sandboxed = _sandbox?.createSandboxedFunction(body);
				return [key, () => sandboxed?.(emailProps as Record<string, unknown>)];
			}
			return [key, value];
		}),
	);
}

type TwilioSMSParams = {
	accountSid: string;
	authToken: string;
	to: string;
	from: string;
	body: string;
};

export async function sendTwilioSMS({
	accountSid,
	authToken,
	to,
	from,
	body,
}: TwilioSMSParams) {
	const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

	const form = new URLSearchParams({
		To: to,
		From: from,
		Body: body,
	});

	const auth = btoa(`${accountSid}:${authToken}`);

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Basic ${auth}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: form.toString(),
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Twilio error ${res.status}: ${err}`);
	}

	return res.json();
}

async function getCopyTemplateFromName({
	name,
	env,
	project,
}: {
	name: string | null;
	project: Project;
	env: Env;
}): Promise<ReturnType<typeof parseDBCopyTemplate> | undefined> {
	if (!name) return undefined;
	const template = await drizzle(env.AUTH_DB)
		.select()
		.from(WebUiCopyTemplateTable)
		.where(
			and(
				eq(WebUiCopyTemplateTable.name, name),
				eq(WebUiCopyTemplateTable.owner_id, project.owner_id),
			),
		)
		.get();
	if (!template) return undefined;
	return parseDBCopyTemplate(template);
}

function OAuth2Fetcher<UserInfo>(
	url: string,
	token: string,
	extraHeaders?: Record<string, string>,
) {
	return fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "OpenAuthSter Issuer",
			...extraHeaders,
		},
	})
		.then(async (res) => {
			if (!res.ok) {
				console.error("OAuth2 API error:", res.status, res.statusText);
				throw new Error(await res.text());
			}
			return res;
		})
		.then((res) => res.json() as Promise<UserInfo>);
}

// Password Provider ///////////////////////

const passwordConfigBuilder: ConfigType<
	PasswordProviderConfig,
	{ provider: "password"; email: string },
	{ email: string }
> = {
	provider: ({
		globalConfig,
		providerConfig,
		env,
		project,
		copyTemplate,
		ctx,
	}) =>
		import("@kagii/openauth/provider/password").then(async (mod) =>
			mod.PasswordProvider(
				PasswordUI({
					sendCode: async (email, code, type) => {
						await sendCode({
							to: email,
							code,
							globalConfig,
							project,
							type: type === "change" ? "change_password" : type,
							emailTemplate: await getEmailTemplate({
								env,
								id:
									type === "register"
										? providerConfig.data.registerTemplateId
										: providerConfig.data.resetPasswordTemplateId,
								project,
							}),
							send_type: "email",
							ctx,
						}).then(() => {
							// Trigger webhooks for code_sent event
							return new WebHook({ db: env.AUTH_DB }).trigger({
								clientID: project.clientID,
								event: "code_sent",
								secret: project.secret,
								data: {
									code,
									method: "email",
									send_to: email,
									provider: "password",
								},
								request: ctx.req.raw,
							});
						});
					},
					copy: copyTemplate?.copyData.password,
					validatePassword(password) {
						const {
							minLength,
							requireUppercase,
							requireNumber,
							requireSpecialChar,
						} = providerConfig.data;
						const {
							shortPasswordMsg = `Password must be at least ${minLength} characters.`,
							requireUppercaseMsg = "Password must contain an uppercase letter.",
							requireNumberMsg = "Password must contain a number.",
							requireSpecialCharMsg = "Password must contain a special character.",
						} = copyTemplate?.copyData.password || {};
						if (minLength) {
							if (password.length < minLength)
								return shortPasswordMsg.replace("{min}", minLength.toString());
							else if (
								requireUppercase &&
								password === password.toLocaleLowerCase()
							)
								return requireUppercaseMsg;
							else if (requireNumber && !/\d/.test(password))
								return requireNumberMsg;
							else if (
								requireSpecialChar &&
								!/[!@#$%^&*(),.?":{}|<>]/.test(password)
							)
								return requireSpecialCharMsg;
						}
					},
				}),
			),
		),
	parser: (data) => {
		return {
			identifier: data.email,
			data: { email: data.email },
		};
	},
};

// OIDC Provider /////////////////////////////
const oidcConfigBuilder: ConfigType<
	OIDCProviderConfig,
	{
		id: JWTPayload;
		clientID: string;
	},
	JWTPayload
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/oidc").then((m) =>
			m.OidcProvider(providerConfig.data),
		),
	parser: (data) => {
		if (!data.id.sub) {
			throw new Error(
				"OIDC provider did not return a sub claim in the ID token, which is required for user identification.",
			);
		}

		return {
			identifier: data.id.sub,
			data: data.id,
		};
	},
};

// Code Provider /////////////////////////////
const codeConfigBuilder: ConfigType<
	CodeProviderConfig,
	{
		claims: Record<"phone" | "email", string>;
	},
	{ email?: string; phone?: string }
> = {
	provider: async ({
		env,
		globalConfig,
		project,
		copyTemplate,
		ctx,
		providerConfig,
	}) => {
		const codeUI = (await import("@kagii/openauth/ui/code")).CodeUI({
			copy: copyTemplate?.copyData.code,
			mode: providerConfig.data.codeMode,
			sendCode: async (claim, code) => {
				await sendCode({
					code,
					project,
					to: claim.email || claim.phone,
					globalConfig,
					emailTemplate: await getEmailTemplate({
						env,
						id: providerConfig.data.registerTemplateId,
						project,
					}),
					type: "login",
					send_type: claim.email ? "email" : "phone",
					ctx,
				}).then(() => {
					// Trigger webhooks for code_sent event
					return new WebHook({ db: env.AUTH_DB }).trigger({
						clientID: project.clientID,
						event: "code_sent",
						secret: project.secret,
						data: {
							code,
							method: providerConfig.data.codeMode,
							send_to: claim.email || claim.phone,
							provider: "code",
						},
						request: ctx.req.raw,
					});
				});
			},
		});
		const codeProvider = (await import("@kagii/openauth/provider/code"))
			.CodeProvider;
		return codeProvider({
			...codeUI,
		});
	},
	parser: (data) => {
		return {
			identifier: data.claims.email || data.claims.phone,
			data: data.claims,
		};
	},
};

// Apple Providers /////////////////////////////

type AppleSuccessValues =
	| { id: JWTPayload; clientID: string }
	| { tokenset: TokenSet; clientID: string };

const appleBuilder: ConfigType<
	AppleOAuthProviderConfig | AppleOIDCProviderConfig,
	AppleSuccessValues,
	JWTPayload
> = {
	provider: async (props) => {
		const mod = await import("@kagii/openauth/provider/apple");
		if (props.providerConfig.type === "appleoauth") {
			return mod.AppleProvider(props.providerConfig.data);
		} else if (props.providerConfig.type === "appleoidc") {
			return mod.AppleOidcProvider(props.providerConfig.data);
		} else {
			throw new Error("Invalid provider config type for Apple provider");
		}
	},
	parser: async (data) => {
		if ("tokenset" in data) {
			// OAuth2 flow — Apple has no REST userinfo API; decode the id_token JWT
			const idToken = data.tokenset.raw.id_token as string | undefined;
			if (!idToken) {
				throw new Error(
					"Apple OAuth2 token response did not include an id_token",
				);
			}
			const payload = JSON.parse(
				atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
			) as JWTPayload;
			return {
				identifier: payload.sub as string,
				data: payload,
			};
		} else {
			// OIDC flow, we can get the user info from the id token claims
			return {
				identifier: data.id.sub as string,
				data: data.id,
			};
		}
	},
};

// X Provider /////////////////////////////

export type XUserInfo = {
	data: {
		id: string;
		name: string;
		username: string;
		profile_image_url?: string;
	};
};

const xBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	XUserInfo["data"]
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/x").then((mod) =>
			mod.XProvider({
				...providerConfig.data,
				scopes: ["users.read", "tweet.read"],
			}),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<XUserInfo>(
			"https://api.twitter.com/2/users/me?user.fields=id,name,username,profile_image_url",
			data.tokenset.access,
		);
		return {
			identifier: info.data.id,
			data: info.data,
		};
	},
};

// slack Provider /////////////////////////////

export type SlackUserInfo = {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
	given_name?: string;
	family_name?: string;
	locale?: string;
	[key: string]: unknown;
};

const slackBuilder: ConfigType<
	SlackProviderConfig,
	{ tokenset: TokenSet; clientID: string },
	SlackUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/slack").then((mod) =>
			mod.SlackProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<SlackUserInfo>(
			"https://slack.com/api/openid.connect.userInfo",
			data.tokenset.access,
		);
		return {
			identifier: info.sub || (info.email as string),
			data: info,
		};
	},
};

// Cognito Provider /////////////////////////////

export type CognitoUserInfo = {
	sub: string;
	email?: string;
	email_verified?: string;
	username?: string;
	name?: string;
	[key: string]: unknown;
};

const cognitoBuilder: ConfigType<
	CognitoProviderConfig,
	{ tokenset: TokenSet; clientID: string },
	CognitoUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/cognito").then((mod) =>
			mod.CognitoProvider(providerConfig.data),
		),
	parser: async (data, providerConfig) => {
		const { domain, region } = providerConfig.data;
		const info = await OAuth2Fetcher<CognitoUserInfo>(
			`https://${domain}.auth.${region}.amazoncognito.com/oauth2/userInfo`,
			data.tokenset.access,
		);
		return {
			identifier: info.sub || (info.email as string),
			data: info,
		};
	},
};

// discord Provider /////////////////////////////

export type DiscordUserInfo = {
	id: string;
	username: string;
	discriminator: string;
	global_name?: string;
	avatar?: string;
	email?: string;
	verified?: boolean;
	locale?: string;
};

const discordBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	DiscordUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/discord").then((mod) =>
			mod.DiscordProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<DiscordUserInfo>(
			"https://discord.com/api/users/@me",
			data.tokenset.access,
			{
				Accept: "application/json",
			},
		);
		return {
			identifier: info.id,
			data: info,
		};
	},
};

// facebook Provider /////////////////////////////

export type FacebookUserInfo = {
	id: string;
	name?: string;
	email?: string;
	picture?: {
		data: {
			url: string;
			width: number;
			height: number;
		};
	};
};

const facebookBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	FacebookUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/facebook").then((mod) =>
			mod.FacebookProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<FacebookUserInfo>(
			"https://graph.facebook.com/me?fields=id,name,email,picture",
			data.tokenset.access,
			{
				Accept: "application/json",
			},
		);
		return {
			identifier: info.id,
			data: info,
		};
	},
};

// github Provider /////////////////////////////

export type GitHubUserInfo = {
	id: number;
	login: string;
	name?: string;
	email?: string;
	avatar_url?: string;
	bio?: string;
	company?: string;
	location?: string;
};

const githubBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	GitHubUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/github").then((mod) =>
			mod.GithubProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<GitHubUserInfo>(
			"https://api.github.com/user",
			data.tokenset.access,
			{
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		);
		return {
			identifier: String(info.id),
			data: info,
		};
	},
};

// Google OAuth2 Provider /////////////////////////////

export type GoogleData = {
	provider: "google";
	clientID: string;
	tokenset: TokenSet;
};

export type GoogleUserInfo = {
	email?: string;
	email_verified?: boolean;
	sub: string;
	name?: string;
	picture?: string;
	given_name?: string;
	family_name?: string;
};

const googleBuilder: ConfigType<
	GoogleProviderConfig,
	GoogleData,
	GoogleUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/google").then((mod) =>
			mod.GoogleProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<GoogleUserInfo>(
			"https://www.googleapis.com/oauth2/v3/userinfo",
			data.tokenset.access,
			{
				Accept: "application/json",
				"User-Agent": "OpenAuthSter Issuer",
			},
		);

		return {
			identifier: info.sub,
			data: info,
		};
	},
};

/////////////////////////////////////////////

// JumpCloud Provider /////////////////////////////

export type JumpCloudUserInfo = {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	given_name?: string;
	family_name?: string;
};

const jumpcloudBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	JumpCloudUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/jumpcloud").then((mod) =>
			mod.JumpCloudProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<JumpCloudUserInfo>(
			"https://oauth.id.jumpcloud.com/userinfo",
			data.tokenset.access,
		);
		return {
			identifier: info.sub,
			data: info,
		};
	},
};

/////////////////////////////////////////////

// Keycloak Provider /////////////////////////////

export type KeycloakUserInfo = {
	sub: string;
	email?: string;
	email_verified?: boolean;
	preferred_username?: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	[key: string]: unknown;
};

const keycloakBuilder: ConfigType<
	KeycloakProviderConfig,
	{ tokenset: TokenSet; clientID: string },
	KeycloakUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/keycloak").then((mod) =>
			mod.KeycloakProvider(providerConfig.data),
		),
	parser: async (data, providerConfig) => {
		const { baseUrl, realm } = providerConfig.data;
		const info = await OAuth2Fetcher<KeycloakUserInfo>(
			`${baseUrl}/realms/${realm}/protocol/openid-connect/userinfo`,
			data.tokenset.access,
		);
		return {
			identifier: info.sub || (info.email as string),
			data: info,
		};
	},
};

/////////////////////////////////////////////

// Microsoft Provider /////////////////////////////

export type MicrosoftUserInfo = {
	id: string;
	displayName?: string;
	givenName?: string;
	surname?: string;
	mail?: string;
	userPrincipalName: string;
	jobTitle?: string;
};

const microsoftBuilder: ConfigType<
	MicrosoftProviderConfig,
	TokenSetKey,
	MicrosoftUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/microsoft").then((mod) =>
			mod.MicrosoftProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<MicrosoftUserInfo>(
			"https://graph.microsoft.com/v1.0/me",
			data.tokenset.access,
			{
				Accept: "application/json",
			},
		);
		return {
			identifier: info.id,
			data: info,
		};
	},
};

/////////////////////////////////////////////

// OAuth2 Provider /////////////////////////////

const oauth2Builder: ConfigType<
	GenericOAuthProviderConfig,
	{ clientID: string; tokenset: TokenSet },
	JWTPayload
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/oauth2").then((mod) =>
			mod.Oauth2Provider({
				...providerConfig.data,
			}),
		),
	parser: async (data, providerConfig) => {
		const userInfoResponse = await fetch(
			providerConfig.data.userInfoGetter.url,
			{
				method: providerConfig.data.userInfoGetter.method,
				headers: {
					Authorization: `Bearer ${data.tokenset.access}`,
					...providerConfig.data.userInfoGetter.headers,
				},
			},
		).then(async (res) => {
			if (!res.ok) {
				console.error(
					"OAuth2 user info API error:",
					res.status,
					res.statusText,
				);
				throw new Error(await res.text());
			}
			return res.json() as Promise<Record<string, unknown>>;
		});

		let identifier: string = "";

		providerConfig.data.userInfoGetter.idPath.split(".").reduce((acc, part) => {
			if (acc && part in acc) {
				identifier = acc[part] as string;
				return acc[part] as Record<string, unknown>;
			} else {
				throw new Error(
					`Invalid idPath: ${providerConfig.data.userInfoGetter.idPath}`,
				);
			}
		}, userInfoResponse);

		if (identifier === "") {
			throw new Error(
				`Identifier not found at idPath: ${providerConfig.data.userInfoGetter.idPath}`,
			);
		}

		return {
			identifier,
			data: userInfoResponse,
		};
	},
};

////////////////////////////////////////////

// Spotify Provider /////////////////////////////

export type SpotifyUserInfo = {
	id: string;
	display_name?: string;
	email?: string;
	images?: Array<{ url: string; width: number; height: number }>;
	country?: string;
	product?: string;
};

const spotifyBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	SpotifyUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/spotify").then((mod) =>
			mod.SpotifyProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<SpotifyUserInfo>(
			"https://api.spotify.com/v1/me",
			data.tokenset.access,
			{
				Accept: "application/json",
			},
		);
		return {
			identifier: info.id,
			data: info,
		};
	},
};

////////////////////////////////////////////

// Twitch Provider /////////////////////////////

export type TwitchUserInfo = {
	data: Array<{
		id: string;
		login: string;
		display_name: string;
		email?: string;
		profile_image_url?: string;
		broadcaster_type?: string;
	}>;
};

const twitchBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey & { clientID: string },
	TwitchUserInfo["data"][0]
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/twitch").then((mod) =>
			mod.TwitchProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<TwitchUserInfo>(
			"https://api.twitch.tv/helix/users",
			data.tokenset.access,
			{
				"Client-Id": data.clientID,
				Accept: "application/json",
			},
		);
		const user = info.data[0];
		return {
			identifier: user.id,
			data: user,
		};
	},
};

////////////////////////////////////////////

// Yahoo Provider /////////////////////////////

export type YahooUserInfo = {
	sub: string;
	name?: string;
	email?: string;
	email_verified?: boolean;
	picture?: string;
};

const yahooBuilder: ConfigType<
	OAuth2ProviderConfig,
	TokenSetKey,
	YahooUserInfo
> = {
	provider: ({ providerConfig }) =>
		import("@kagii/openauth/provider/yahoo").then((mod) =>
			mod.YahooProvider(providerConfig.data),
		),
	parser: async (data) => {
		const info = await OAuth2Fetcher<YahooUserInfo>(
			"https://api.login.yahoo.com/openid/v1/userinfo",
			data.tokenset.access,
			{
				Accept: "application/json",
			},
		);
		return {
			identifier: info.sub,
			data: info,
		};
	},
};

////////////////////////////////////////////

// QR code Provider /////////////////////////////

const qrBuilder: ConfigType<
	QRProviderConfig,
	QRProviderOnSuccessData,
	QRProviderOnSuccessData
> = {
	async provider({ env, copyTemplate, project, ctx }) {
		if (!project.originURL)
			throw new Error("Project origin URL is required for QR provider");

		const { QrUI, QRProvider } = (await import(
			//@ts-expect-error
			"../node_modules/openauth-webui-shared-types/providers/build/qr/index.js"
		)) as {
			QrUI: typeof import("openauth-webui-shared-types/providers/custom/qr/QRUI.tsx").QrUI;
			QRProvider: typeof import("openauth-webui-shared-types/providers/custom/qr/index.ts").QRProvider;
		};
		const issuer = await import("./endpoints/index").then((m) => m.endpoints);
		const subject = await import("../openauth.config").then((m) => m.subjects);

		return QRProvider(
			QrUI({
				issuerURI: new URL(ctx.req.url).origin,
				binding: env.QR_AUTH_DO,
				copy: copyTemplate?.copyData.qr,
				client_id: project.clientID,
				//@ts-expect-error
				issuer: issuer,
				subject: subject,
			}),
		);
	},
	parser(data) {
		//console.log("data received after parsing:", JSON.stringify({ data }));
		return {
			identifier: data.identifier,
			data: data,
		};
	},
};

// Passkey Provider /////////////////////////////

const passkeyBuilder: ConfigType<
	ProviderConfig,
	{ identifier: string },
	Record<string, string>
> = {
	provider: async ({ env, copyTemplate, project, ctx }) => {
		const mod = (await import(
			//@ts-expect-error
			"../node_modules/openauth-webui-shared-types/providers/build/passkey/index.js"
		)) as typeof import("../node_modules/openauth-webui-shared-types/providers/custom/passkey/index.ts");

		const autorizedOrigin = toAuthorizeOrigin({
			request: ctx.req.raw,
			project,
			env: env,
			defaultOrigin: env.WEBUI_ORIGIN_URL,
		});

		return mod.WebAuthnProvider({
			UI: mod.PassKeyUI({
				copy: copyTemplate?.copyData.passkey,
			}),
			db: env.AUTH_DB,
			origin: autorizedOrigin,
			rpID: new URL(autorizedOrigin).hostname,
		});
	},
	parser: async (data) => {
		return {
			identifier: data.identifier,
			data: undefined,
		};
	},
};

// Provider Map /////////////////////////////

const providerConfigMap: Record<ProviderType, ConfigType<any, any, any>> = {
	code: codeConfigBuilder,
	oidc: oidcConfigBuilder,
	password: passwordConfigBuilder,
	appleoauth: appleBuilder,
	appleoidc: appleBuilder,
	apple: appleBuilder,
	x: xBuilder,
	slack: slackBuilder,
	cognito: cognitoBuilder,
	discord: discordBuilder,
	facebook: facebookBuilder,
	github: githubBuilder,
	google: googleBuilder,
	jumpcloud: jumpcloudBuilder,
	keycloak: keycloakBuilder,
	microsoft: microsoftBuilder,
	oauth: oauth2Builder,
	spotify: spotifyBuilder,
	twitch: twitchBuilder,
	yahoo: yahooBuilder,
	qr: qrBuilder,
	passkey: passkeyBuilder,
};

async function generateProvidersFromConfig({
	project,
	env,
	copyTemplateName,
	ctx,
}: {
	project: Project;
	env: Env;
	ctx: EndpointCtx;
	copyTemplateName: string | null;
}): Promise<Record<string, Provider<unknown>>> {
	const globalConfig: ExternalGlobalProjectConfig = await getGlobalConfig(
		ctx,
		project,
	);

	const providerData =
		project.providers_data?.filter((p) => p.enabled).filter((p) => p.enabled) ||
		[];

	const providers = Object.assign(
		{},
		...(await Promise.all(
			providerData.map(async (providerConfig) => {
				return {
					[providerConfig.type]: await providerConfigMap[
						providerConfig.type
					].provider({
						env,
						globalConfig,
						project,
						providerConfig,
						copyTemplate: await getCopyTemplateFromName({
							name: copyTemplateName ?? null,
							env,
							project,
						}),
						ctx,
					}),
				};
			}),
		)),
	) as Record<string, Provider<unknown>>;
	return providers;
}

export { generateProvidersFromConfig, providerConfigMap };
