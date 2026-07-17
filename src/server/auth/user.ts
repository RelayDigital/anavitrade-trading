import type { User } from "../../drizzle/schema";

export type SafeUser = Pick<
  User,
  | "id"
  | "name"
  | "email"
  | "loginMethod"
  | "role"
  | "emailVerified"
  | "createdAt"
  | "lastSignedIn"
>;

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    lastSignedIn: user.lastSignedIn,
  };
}

