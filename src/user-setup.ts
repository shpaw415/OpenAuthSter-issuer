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

export default {
  extractIdentifierFor: {
    password,
    code,
  },
};
