import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import { ApiError } from "./store.js";

export interface Identity { userId: string; authSession: string }

export function tokenVerifier(supabaseUrl: string, publishableKey: string) {
  const issuer = supabaseUrl + "/auth/v1";
  const keys = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));
  return async (token: string): Promise<Identity> => {
    try {
      const header = decodeProtectedHeader(token);
      let claims;
      if (header.alg === "HS256") {
        // Legacy Supabase projects validate symmetric JWTs at the Auth service.
        // The signing secret never leaves Supabase.
        claims = decodeJwt(token);
        if (claims.iss !== issuer || claims.aud !== "authenticated" || !claims.exp || claims.exp <= Date.now() / 1000) {
          throw new Error("Invalid legacy JWT");
        }
        const response = await fetch(issuer + "/user", {
          headers: { apikey: publishableKey, Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(7000)
        });
        if (!response.ok || (await response.json() as any).id !== claims.sub) throw new Error("Invalid identity");
      } else {
        ({ payload: claims } = await jwtVerify(token, keys, {
          issuer, audience: "authenticated", algorithms: ["ES256", "RS256"]
        }));
      }
      return { userId: z.uuid().parse(claims.sub), authSession: z.uuid().parse(claims.session_id) };
    } catch { throw new ApiError("auth_required", 401); }
  };
}
