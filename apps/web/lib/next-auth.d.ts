import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user?: {
      userId?: string;
      organizationId?: string;
      jwtToken?: string;
    } & DefaultSession["user"];
  }

  interface JWT {
    userId?: string;
    organizationId?: string;
    jwtToken?: string;
  }
}
