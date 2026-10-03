import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("password must be at least 12 characters");
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltText, hashText] = encoded.split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueSessionToken(): { token: string; tokenSha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenSha256: digestSessionToken(token) };
}

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
