import {
  CognitoProviderConfig,
  CopyDataSelection,
  EmailTemplateProps,
  ExternalGlobalProjectConfig,
  GoogleProviderConfig,
  KeycloakProviderConfig,
  MicrosoftProviderConfig,
  OAuth2ProviderConfig,
  OIDCProviderConfig,
  parseDBCopyTemplate,
  PasswordProviderConfig,
  Project,
  SlackProviderConfig,
} from "openauth-webui-shared-types";
import { eq, drizzle } from "openauth-webui-shared-types/drizzle";
import getGlobalConfig from "../openauth.config";
import { Provider } from "@openauthjs/openauth/provider/provider";
import { PasswordUI } from "@openauthjs/openauth/ui/password";
import DefaultEmailTemplateBody from "./defaults/email";
import {
  emailTemplatesTable,
  WebUiCopyTemplateTable,
} from "openauth-webui-shared-types/database";
import { SlackConfig } from "@openauthjs/openauth/provider/slack";

export async function generateProvidersFromConfig({
  project,
  env,
  copyTemplateId,
}: {
  project: Project;
  env: Env;
  copyTemplateId: string | null;
}): Promise<Record<string, Provider<any>>> {
  let globalConfig: ExternalGlobalProjectConfig | undefined = undefined;
  const getSetGlobal = async () => {
    if (!globalConfig) {
      globalConfig = await getGlobalConfig(env);
    }
    return globalConfig;
  };
  const providers = (
    await Promise.all(
      project.providers_data
        .filter((p) => p.enabled)
        .map(async (providerConfig) => {
          switch (providerConfig.type) {
            case "code":
              return {
                code: await createCodeProvider({
                  env,
                  globalConfig: await getSetGlobal(),
                  project,
                  copyTemplateId,
                }),
              };
            case "oidc":
              return {
                oidc: await createOIDCProvider(providerConfig),
              };
            case "apple":
              return {
                apple: await createAppleProvider(providerConfig),
              };
            case "x":
              return {
                x: await createXProvider(providerConfig),
              };
            case "slack":
              return {
                slack: await createSlackProvider(providerConfig),
              };
            case "yahoo":
              return {
                yahoo: await createYahooProvider(providerConfig),
              };
            case "google":
              return {
                google: await createGoogleProvider(providerConfig),
              };
            case "github":
              return {
                github: await createGitHubProvider(providerConfig),
              };
            case "twitch":
              return {
                twitch: await createTwitchProvider(providerConfig),
              };
            case "spotify":
              return {
                spotify: await createSpotifyProvider(providerConfig),
              };
            case "cognito":
              return {
                cognito: await createCognitoProvider(providerConfig),
              };
            case "discord":
              return {
                discord: await createDiscordProvider(providerConfig),
              };
            case "facebook":
              return {
                facebook: await createFacebookProvider(providerConfig),
              };
            case "keycloak":
              return {
                keycloak: await createKeycloakProvider(providerConfig),
              };
            case "password":
              return {
                password: await createPasswordProvider({
                  globalConfig: await getSetGlobal(),
                  providerConfig,
                  env,
                  project,
                  copyTemplateId,
                }),
              };
            case "microsoft":
              return {
                microsoft: await createMicrosoftProvider(providerConfig),
              };
            case "jumpcloud":
              return {
                jumpcloud: await createJumpCloudProvider(providerConfig),
              };

            default:
              throw new Error(
                `Unsupported provider type: ${providerConfig.type}`,
              );
          }
        }),
    )
  ).reduce((acc, curr) => ({ ...acc, ...curr }), {});
  return providers;
}

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

async function createPasswordProvider({
  globalConfig,
  providerConfig,
  env,
  project,
  copyTemplateId,
}: {
  globalConfig: ExternalGlobalProjectConfig;
  providerConfig: PasswordProviderConfig;
  env: Env;
  project: Project;
  copyTemplateId: string | null;
}) {
  return (
    await import("@openauthjs/openauth/provider/password")
  ).PasswordProvider(
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
  );
}

async function createCodeProvider({
  env,
  globalConfig,
  project,
  copyTemplateId,
}: {
  env: Env;
  globalConfig: ExternalGlobalProjectConfig;
  project: Project;
  copyTemplateId: string | null;
}) {
  const copyData = await getCopyTemplateFromId<"code">(
    copyTemplateId ?? null,
    env,
  );
  const codeUI = (await import("@openauthjs/openauth/ui/code")).CodeUI({
    copy: copyData,
    mode: project.codeMode,
    sendCode: async (claim, code) => {
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

async function createGoogleProvider(providerConfig: GoogleProviderConfig) {
  return (await import("@openauthjs/openauth/provider/google")).GoogleProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    query: providerConfig.data.query,
    pkce: providerConfig.data.pkce,
  });
}

async function createGitHubProvider(providerConfig: OAuth2ProviderConfig) {
  return (await import("@openauthjs/openauth/provider/github")).GithubProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["email", "profile"],
    pkce: providerConfig.data.pkce,
    query: providerConfig.data.query,
  });
}

async function createFacebookProvider(providerConfig: OAuth2ProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/facebook")
  ).FacebookProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["email", "public_profile"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}

async function createAppleProvider(providerConfig: OAuth2ProviderConfig) {
  return (await import("@openauthjs/openauth/provider/apple")).AppleProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["name", "email"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}

async function createXProvider(providerConfig: OAuth2ProviderConfig) {
  return (await import("@openauthjs/openauth/provider/x")).XProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || [
      "tweet.read",
      "users.read",
      "offline.access",
    ],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}

async function createOIDCProvider(providerConfig: OIDCProviderConfig) {
  return (await import("@openauthjs/openauth/provider/oidc")).OidcProvider({
    clientID: providerConfig.data.clientID,
    issuer: providerConfig.data.issuer,
    scopes: providerConfig.data.scopes || ["openid", "profile", "email"],
    query: providerConfig.data.query,
  });
}

async function createSlackProvider(providerConfig: SlackProviderConfig) {
  return (await import("@openauthjs/openauth/provider/slack")).SlackProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: (providerConfig.data
      .scopes as unknown as SlackConfig["scopes"]) || ["email"],
    team: providerConfig.data.team,
    pkce: providerConfig.data.pkce,
  });
}

async function createYahooProvider(providerConfig: OAuth2ProviderConfig) {
  return (await import("@openauthjs/openauth/provider/yahoo")).YahooProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}

async function createTwitchProvider(providerConfig: OAuth2ProviderConfig) {
  return (await import("@openauthjs/openauth/provider/twitch")).TwitchProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["email", "profile"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}

async function createSpotifyProvider(providerConfig: OAuth2ProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/spotify")
  ).SpotifyProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || [
      "user-read-email",
      "user-read-private",
    ],
    pkce: providerConfig.data.pkce,
    query: providerConfig.data.query,
  });
}

async function createCognitoProvider(providerConfig: CognitoProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/cognito")
  ).CognitoProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    pkce: providerConfig.data.pkce,
    query: providerConfig.data.query,
    region: providerConfig.data.region,
    domain: providerConfig.data.domain,
  });
}

async function createDiscordProvider(providerConfig: OAuth2ProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/discord")
  ).DiscordProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["identify", "email"],
    pkce: providerConfig.data.pkce,
    query: providerConfig.data.query,
  });
}

async function createKeycloakProvider(providerConfig: KeycloakProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/keycloak")
  ).KeycloakProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    pkce: providerConfig.data.pkce,
    query: providerConfig.data.query,
    baseUrl: providerConfig.data.baseUrl,
    realm: providerConfig.data.realm,
  });
}

async function createMicrosoftProvider(
  providerConfig: MicrosoftProviderConfig,
) {
  return (
    await import("@openauthjs/openauth/provider/microsoft")
  ).MicrosoftProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
    tenant: providerConfig.data.tenant,
  });
}

async function createJumpCloudProvider(providerConfig: OAuth2ProviderConfig) {
  return (
    await import("@openauthjs/openauth/provider/jumpcloud")
  ).JumpCloudProvider({
    clientID: providerConfig.data.clientID,
    clientSecret: providerConfig.data.clientSecret,
    scopes: providerConfig.data.scopes || ["openid", "email", "profile"],
    pkce: providerConfig.data.pkce || false,
    query: providerConfig.data.query,
  });
}
