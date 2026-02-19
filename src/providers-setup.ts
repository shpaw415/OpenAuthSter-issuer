import type {
  AppleOAuthProviderConfig,
  AppleOIDCProviderConfig,
  CodeProviderConfig,
  CognitoProviderConfig,
  CopyDataSelection,
  EmailTemplateProps,
  ExternalGlobalProjectConfig,
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
  SlackProviderConfig,
} from "openauth-webui-shared-types";
import { parseDBCopyTemplate } from "openauth-webui-shared-types";
import { eq, drizzle } from "openauth-webui-shared-types/drizzle";
import getGlobalConfig from "../openauth.config";
import { Provider } from "@openauthjs/openauth/provider/provider";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import DefaultEmailTemplateBody from "./defaults/email";
import {
  emailTemplatesTable,
  WebUiCopyTemplateTable,
} from "openauth-webui-shared-types/database";
import { JWTPayload } from "jose";
import { WebHook } from "openauth-webui-shared-types/webhook";

export type userExtractResult<T extends Record<string, any>> = {
  identifier: string;
  data?: T;
};
export type userExtractFunction<
  Input,
  Output extends Record<string, any>,
  ProviderConf extends ProviderConfig,
> = (
  data: Input,
  providerConfig: ProviderConf,
) => userExtractResult<Output> | Promise<userExtractResult<Output>>;
export type OnSuccessParserData<T> = {
  identifier: string;
  data: T;
};

export type TokenSet = {
  access: string;
  refresh: any;
  expiry: number;
  raw: Record<string, any>;
};

export type TokenSetKey = {
  tokenset: TokenSet;
};

type ConfigType<
  ProviderConf extends ProviderConfig,
  Input extends Record<string, any>,
  Output extends Record<string, any>,
> = {
  provider: (props: {
    globalConfig: ExternalGlobalProjectConfig;
    providerConfig: ProviderConf;
    env: Env;
    project: Project;
    copyTemplateId: string | null;
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
  name,
}: {
  env: Env;
  name?: string | null;
}): Promise<EmailTemplateProps> {
  if (!name) return defaultEmailTemplateProps;

  return drizzle(env.AUTH_DB)
    .select({
      name: emailTemplatesTable.name,
      subject: emailTemplatesTable.subject,
      body: emailTemplatesTable.body,
    })
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.name, name))
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

async function sendCodeWithEmail({
  code,
  project,
  to,
  globalConfig,
  emailTemplate,
}: {
  code: string;
  project: Project;
  to: string;
  globalConfig: ExternalGlobalProjectConfig;
  emailTemplate: EmailTemplateProps;
}) {
  if (project.codeMode !== "email") return;
  const mustache = (await import("mustache")).default;
  switch (globalConfig.register.strategy.email?.provider) {
    case "resend":
      const apiKey = globalConfig.register.strategy.email.apiKey;
      console.log(`Sending code ${code} to ${to} via Resend`);
      const result = await new (await import("resend")).Resend(
        apiKey,
      ).emails.send({
        from: `Acme <${project.projectData?.emailFrom || globalConfig.register.fallbackEmailFrom}>`,
        to: [to],
        subject: emailTemplate.subject || "Your verification code",
        html: mustache.render(emailTemplate.body, {
          code,
          ...project.projectData,
        }),
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
    // Add other strategies as needed
    default:
      console.log(`Sending code ${code} to ${to} via default method`);
  }
}

async function sendCodeWithSMS({
  code,
  to,
  globalConfig,
  emailTemplateProps,
  project,
}: {
  code: string;
  to: string;
  globalConfig: ExternalGlobalProjectConfig;
  emailTemplateProps: EmailTemplateProps;
  project: Project;
}) {
  if (project.codeMode !== "phone") return;
  switch (globalConfig.register.strategy.phone?.provider) {
    case "twilio":
      const twilioConfig = globalConfig.register.strategy.phone;
      const res = await sendTwilioSMS({
        accountSid: twilioConfig.accountSID,
        authToken: twilioConfig.authToken,
        to,
        from: twilioConfig.fromNumber,
        body: (await import("mustache")).default.render(
          emailTemplateProps.body,
          {
            code,
            ...project.projectData,
          },
        ),
      });
      console.log("Twilio SMS log:", res);
      break;
    case "custom":
      await globalConfig.register.strategy.phone.sendSMSFunction(to, code);
      break;
    default:
      console.log(`Sending code ${code} to ${to} via default SMS method`);
      break;
  }
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

async function getCopyTemplateFromId<T extends keyof CopyDataSelection>(
  id: string | null,
  env: Env,
): Promise<CopyDataSelection[T] | undefined> {
  if (!id) return undefined;
  const template = await drizzle(env.AUTH_DB)
    .select()
    .from(WebUiCopyTemplateTable)
    .where(eq(WebUiCopyTemplateTable.name, id))
    .limit(1)
    .get();
  if (!template) return undefined;
  return parseDBCopyTemplate<CopyDataSelection[T]>(template).copyData;
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

type ProviderToOutput<ProviderUserInfo> = Omit<ProviderUserInfo, "provider">;

// Password Provider ///////////////////////

const passwordConfigBuilder: ConfigType<
  PasswordProviderConfig,
  { provider: "password"; email: string },
  { email: string }
> = {
  provider: ({ globalConfig, providerConfig, env, project, copyTemplateId }) =>
    import("@openauthjs/openauth/provider/password").then(async (mod) =>
      mod.PasswordProvider(
        PasswordUI({
          sendCode: async (email, code) => {
            if (project.codeMode == "phone")
              console.warn(
                "Project is set to phone code mode, but password provider is only supporting sending code via email.",
              );
            if (project.codeMode == "email") {
              await sendCodeWithEmail({
                to: email,
                code,
                globalConfig,
                project,
                emailTemplate: await getEmailTemplate({
                  env,
                  name: project.emailTemplateId,
                }),
              });
            }
          },
          copy: await getCopyTemplateFromId<"password">(
            copyTemplateId ?? null,
            env,
          ),
          validatePassword(password) {
            const {
              minLength,
              requireUppercase,
              requireNumber,
              requireSpecialChar,
            } = providerConfig.data;
            const {
              shortPasswordMsg,
              requireUppercaseMsg,
              requireNumberMsg,
              requireSpecialCharMsg,
            } = providerConfig.data;
            if (minLength) {
              if (password.length < minLength)
                return shortPasswordMsg || "Password is too short.";
              else if (
                requireUppercase &&
                password.toLocaleUpperCase() === password
              )
                return (
                  requireUppercaseMsg ||
                  "Password must contain an uppercase letter."
                );
              else if (requireNumber && !/\d/.test(password))
                return requireNumberMsg || "Password must contain a number.";
              else if (
                requireSpecialChar &&
                !/[!@#$%^&*(),.?":{}|<>]/.test(password)
              )
                return (
                  requireSpecialCharMsg ||
                  "Password must contain a special character."
                );
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
    import("@openauthjs/openauth/provider/oidc").then((m) =>
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
  provider: async ({ env, globalConfig, project, copyTemplateId }) => {
    const copyData = await getCopyTemplateFromId<"code">(
      copyTemplateId ?? null,
      env,
    );
    const codeUI = (await import("@openauthjs/openauth/ui/code")).CodeUI({
      copy: copyData,
      mode: project.codeMode,
      sendCode: async (claim, code) => {
        // Trigger webhooks for code_sent event
        await new WebHook({ db: env.AUTH_DB }).trigger({
          clientID: project.clientID,
          event: "code_sent",
          secret: project.secret,
          data: { claim, code },
        });

        console.log({ claim, code });
        switch (project.codeMode) {
          case "email":
            if (!claim.email) {
              throw new Error("No email provided for code delivery.");
            }
            await sendCodeWithEmail({
              code,
              to: claim.email! as string,
              globalConfig,
              project,
              emailTemplate: await getEmailTemplate({
                env,
                name: project.emailTemplateId,
              }),
            });
            break;
          case "phone":
            if (!claim.phone) {
              throw new Error("No phone number provided for code delivery.");
            }

            await sendCodeWithSMS({
              code,
              to: claim.phone! as string,
              globalConfig,
              emailTemplateProps: await getEmailTemplate({
                env,
                name: project.emailTemplateId,
              }),
              project,
            });
            break;
          default:
            throw new Error(`Unsupported code mode: ${project.codeMode}`);
        }
      },
    });
    const codeProvider = (await import("@openauthjs/openauth/provider/code"))
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
  Record<string, any>
> = {
  provider: async (props) => {
    const mod = await import("@openauthjs/openauth/provider/apple");
    if (props.providerConfig.type == "appleoauth") {
      return mod.AppleProvider(props.providerConfig.data);
    } else if (props.providerConfig.type == "appleoidc") {
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
      ) as Record<string, any>;
      return {
        identifier: payload.sub as string,
        data: payload,
      };
    } else {
      // OIDC flow, we can get the user info from the id token claims
      return {
        identifier: data.id.sub!,
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
    import("@openauthjs/openauth/provider/x").then((mod) =>
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
    import("@openauthjs/openauth/provider/slack").then((mod) =>
      mod.SlackProvider(providerConfig.data),
    ),
  parser: async (data) => {
    const info = await OAuth2Fetcher<SlackUserInfo>(
      "https://slack.com/api/openid.connect.userInfo",
      data.tokenset.access,
    );
    return {
      identifier: info.sub || info.email!,
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
    import("@openauthjs/openauth/provider/cognito").then((mod) =>
      mod.CognitoProvider(providerConfig.data),
    ),
  parser: async (data, providerConfig) => {
    const { domain, region } = providerConfig.data;
    const info = await OAuth2Fetcher<CognitoUserInfo>(
      `https://${domain}.auth.${region}.amazoncognito.com/oauth2/userInfo`,
      data.tokenset.access,
    );
    return {
      identifier: info.sub || info.email!,
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
    import("@openauthjs/openauth/provider/discord").then((mod) =>
      mod.DiscordProvider({
        scopes: ["identify", "email"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/facebook").then((mod) =>
      mod.FacebookProvider({
        scopes: ["email", "public_profile"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/github").then((mod) =>
      mod.GithubProvider({
        scopes: ["user:email", "read:user"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/google").then((mod) =>
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
    import("@openauthjs/openauth/provider/jumpcloud").then((mod) =>
      mod.JumpCloudProvider({
        scopes: ["openid", "email", "profile"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/keycloak").then((mod) =>
      mod.KeycloakProvider(providerConfig.data),
    ),
  parser: async (data, providerConfig) => {
    const { baseUrl, realm } = providerConfig.data;
    const info = await OAuth2Fetcher<KeycloakUserInfo>(
      `${baseUrl}/realms/${realm}/protocol/openid-connect/userinfo`,
      data.tokenset.access,
    );
    return {
      identifier: info.sub || info.email!,
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
    import("@openauthjs/openauth/provider/microsoft").then((mod) =>
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
  Record<string, any>
> = {
  provider: ({ providerConfig }) =>
    import("@openauthjs/openauth/provider/oauth2").then((mod) =>
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
      return res.json() as Promise<Record<string, any>>;
    });

    let identifier: string;

    providerConfig.data.userInfoGetter.idPath.split(".").reduce((acc, part) => {
      if (acc && part in acc) {
        identifier = acc[part];
        return acc[part];
      } else {
        throw new Error(
          `Invalid idPath: ${providerConfig.data.userInfoGetter.idPath}`,
        );
      }
    }, userInfoResponse);

    return {
      identifier: identifier!,
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
    import("@openauthjs/openauth/provider/spotify").then((mod) =>
      mod.SpotifyProvider({
        scopes: ["user-read-email", "user-read-private"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/twitch").then((mod) =>
      mod.TwitchProvider({
        scopes: ["user:read:email"],
        ...providerConfig.data,
      }),
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
    import("@openauthjs/openauth/provider/yahoo").then((mod) =>
      mod.YahooProvider({
        scopes: ["openid", "email", "profile"],
        ...providerConfig.data,
      }),
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
};

async function generateProvidersFromConfig({
  project,
  env,
  copyTemplateId,
}: {
  project: Project;
  env: Env;
  copyTemplateId: string | null;
}): Promise<Record<string, Provider<any>>> {
  const globalConfig: ExternalGlobalProjectConfig = await getGlobalConfig(env);

  const providers = (
    await Promise.all(
      project.providers_data
        .filter((p) => p.enabled)
        .map(async (providerConfig) => {
          return {
            [providerConfig.type]: await providerConfigMap[
              providerConfig.type
            ].provider({
              env,
              globalConfig,
              project,
              providerConfig,
              copyTemplateId,
            }),
          };
        }),
    )
  ).reduce((acc, curr) => ({ ...acc, ...curr }), {});
  return providers;
}

export { generateProvidersFromConfig, providerConfigMap };
