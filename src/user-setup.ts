export type OnSuccessParserData<T> = {
  identifier: string;
  data: T;
};

export type PasswordData = {
  provider: "password";
  email: string;
};

function password(data: PasswordData): string {
  return data.email;
}

export type CodeData = {
  provider: "code";
  claims: Record<"phone" | "email", string>;
};

function code(data: CodeData): string {
  return data.claims.email || data.claims.phone;
}

export type GoogleData = {
  provider: "google";
  claims: {
    email: string;
    email_verified: boolean;
    sub: string;
  };
};

function google(data: GoogleData): string {
  return data.claims.email;
}

export default {
  extractIdentifierFor: {
    password,
    code,
    google,
  },
};
