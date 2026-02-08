export type userExtractResult<T extends Record<string, any>> = {
  identifier: string;
  data?: T;
};
export type userExtractFunction<Input, Output extends Record<string, any>> = (
  data: Input,
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

export type OpenAuthster = {
  authResponse: {
    password: PasswordData;
    code: {
      openAuth: CodeData;
      userInfo: CodeData["claims"];
    };
    google: {
      openauth: GoogleData;
      userinfo: GoogleUserInfo;
    };
  };
};

function OAuth2Fetcher<UserInfo>(
  url: string,
  token: string,
  extraHeaders?: Record<string, string>,
) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
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

//////////////

// Password Provider ///////////////////////
export type PasswordData = {
  provider: "password";
  email: string;
};

const password: userExtractFunction<PasswordData, { email: string }> = (
  data,
) => {
  return {
    identifier: data.email,
    data: { email: data.email },
  };
};
//////////////////////////////////////////

// Code Provider /////////////////////////////
export type CodeData = {
  provider: "code";
  claims: Record<"phone" | "email", string>;
};

const code: userExtractFunction<
  CodeData,
  { email?: string; phone?: string }
> = (data) => {
  return {
    identifier: data.claims.email || data.claims.phone,
    data: data.claims,
  };
};
////////////////////////////////////////////

// Google OAuth2 Provider ///////////////////////
export type GoogleData = {
  provider: "google";
  clientID: string;
  tokenset: {
    access: string;
    refresh: any;
    expiry: number;
    raw: {
      access_token: string;
      expires_in: number;
      token_type: string;
      id_token: string;
      scope: string;
    };
  };
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

const google: userExtractFunction<GoogleData, GoogleUserInfo> = async (
  data,
) => {
  const info = await OAuth2Fetcher<GoogleUserInfo>(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    data.tokenset.access,
  );

  return {
    identifier: info.sub,
    data: info,
  };
};
//////////////////////////////////////////////////

export type GithubData = {
  provider: "github";
} & TokenSetKey;
export type GithubUserInfo = Partial<{
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: "User" | string;
  user_view_type: "public" | string;
  site_admin: boolean;
  name: string;
  company: string | null;
  blog: string;
  location: string | null;
  email: string | null;
  hireable: string | null;
  bio: string | null;
  twitter_username: string | null;
  notification_email: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}>;

const github: userExtractFunction<GithubData, GithubUserInfo> = async (
  data,
) => {
  const userInfo = await OAuth2Fetcher<GithubUserInfo>(
    "https://api.github.com/user",
    data.tokenset.access,
    {
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenAuthster",
    },
  );
  return {
    identifier: String(userInfo.id),
    data: userInfo,
  };
};

//////////////////////////////////////////////

// Discord OAuth2 Provider ///////////////////////

export type DiscordData = {
  provider: "discord";
} & TokenSetKey;
export type DiscordUserInfo = Partial<{
  id: string;
  username: string;
  discriminator: string;
  global_name: string;
  email: string;
  verified: boolean;
}>;

const discord: userExtractFunction<DiscordData, DiscordUserInfo> = async (
  data,
) => {
  const userInfo = await OAuth2Fetcher<DiscordUserInfo>(
    "https://discord.com/api/users/@me",
    data.tokenset.access,
    {
      "User-Agent": "OpenAuthster",
    },
  );

  return {
    identifier: userInfo.id!,
    data: userInfo,
  };
};
//////////////////////////////////////////////

// Apple OAuth2 Provider ///////////////////////

export type AppleData = {
  provider: "apple";
} & TokenSetKey;
export type AppleUserInfo = Partial<{
  sub: string;
  email: string;
  email_verified: string;
}>;

const apple: userExtractFunction<any, any> = async (data) => {
  console.log("Apple data:", data);

  const jwtDecode = (await import("jose")).decodeJwt;

  return {
    identifier: "",
    data: {},
  };
};

//////////////////////////////////////////////

export default {
  extractIdentifierFor: {
    password,
    code,
    google,
    github,
    discord,
    apple,
  },
};
