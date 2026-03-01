import bcrypt from "bcryptjs";

export async function encryptData(data: string): Promise<string> {
  return bcrypt.hash(data, 10);
}

export async function verifyData(data: string, hash: string): Promise<boolean> {
  return bcrypt.compare(data, hash);
}
