import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnvironment } from "@/app";
import type { RateLimitIdentity } from "@/ports/cache";
import { getClientAddress, services } from "@/middleware/hono-context";

export interface RateLimitOptions {
  bucket: string;
  limit: number;
  windowSeconds: number;
  identity?: RateLimitIdentity;
  rateLimitKey?: string;
}

export const GLOBAL_REQUEST_LIMIT = {
  bucket: "global",
  limit: 10_000,
  windowSeconds: 15 * 60,
} as const;

export const AUTH_LOGIN_LIMIT = {
  bucket: "auth-login",
  limit: 20,
  windowSeconds: 15 * 60,
} as const;

export const PLATFORM_AUTH_REFRESH_LIMIT = {
  bucket: "platform-auth-refresh",
  limit: 120,
  windowSeconds: 15 * 60,
} as const;

export const PLATFORM_AUTH_LOGIN_LIMIT = {
  bucket: "platform-auth-login",
  limit: 20,
  windowSeconds: 15 * 60,
} as const;

export const PLATFORM_AUTH_LOGIN_ACCOUNT_LIMIT = {
  bucket: "platform-auth-login-account",
  limit: 50,
  windowSeconds: 15 * 60,
} as const;

const PLATFORM_LOGIN_ACCOUNT_KEY_DOMAIN =
  "imsweb:platform-auth:login-account:v1\0";

export function platformLoginAccountRateLimitKey(
  normalizedEmail: string,
): string {
  return createHash("sha256")
    .update(PLATFORM_LOGIN_ACCOUNT_KEY_DOMAIN)
    .update(normalizedEmail)
    .digest("hex");
}

export const PLATFORM_AUTH_REGISTER_LIMIT = {
  bucket: "platform-auth-register",
  limit: 10,
  windowSeconds: 60 * 60,
} as const;

export const PLATFORM_AUTH_EMAIL_VERIFICATION_LIMIT = {
  bucket: "platform-auth-email-verification",
  limit: 10,
  windowSeconds: 60 * 60,
} as const;

export const REACTION_LIMIT = {
  bucket: "reactions",
  limit: 300,
  windowSeconds: 60 * 60,
} as const;

export const CHRONICLE_UPLOAD_ATTEMPT_LIMIT = {
  bucket: "chronicle-upload-attempt",
  limit: 60,
  windowSeconds: 60 * 60,
} as const;

export const CHRONICLE_UPLOAD_WRITE_LIMIT = {
  bucket: "chronicle-upload-write",
  limit: 30,
  windowSeconds: 60 * 60,
} as const;

export const FUDABA_UPLOAD_ATTEMPT_LIMIT = {
  bucket: "fudaba-upload-attempt",
  limit: 60,
  windowSeconds: 60 * 60,
} as const;

export const FUDABA_WRITE_ATTEMPT_LIMIT = {
  bucket: "fudaba-write-attempt",
  limit: 240,
  windowSeconds: 60 * 60,
} as const;

export const FUDABA_MAP_READ_LIMIT = {
  bucket: "fudaba-map-ip",
  limit: 300,
  windowSeconds: 15 * 60,
} as const;

export const FUDABA_LOCATION_WRITE_LIMIT = {
  bucket: "fudaba-location-ip",
  limit: 60,
  windowSeconds: 60 * 60,
} as const;

export function chronicleUploadIdempotencyKey(request: Request): string | null {
  if (!request.headers.has("Idempotency-Key")) return null;
  const key = request.headers.get("Idempotency-Key") ?? "";
  if (
    !key ||
    key !== key.trim() ||
    key.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw Object.assign(new Error("无效的幂等键"), { status: 400 });
  }
  return key;
}

export function isDynamicBusinessRequest(
  method: string,
  pathname: string,
): boolean {
  if (method === "OPTIONS") return false;
  if (pathname === "/api/health/live" || pathname === "/api/wiki/test") {
    return false;
  }
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/eventchronicle" ||
    pathname.startsWith("/eventchronicle/")
  );
}

export function validatedRequestPath(c: Context<AppEnvironment>): string {
  const rawPathname = new URL(c.req.raw.url).pathname;
  try {
    // Hono has already decoded the routing path into c.req.path. Decode the
    // raw pathname only as validation so encoded separators and %25 are
    // never decoded a second time for middleware classification.
    decodeURI(rawPathname);
  } catch {
    throw Object.assign(new Error("Malformed request path"), { status: 400 });
  }
  return c.req.path;
}

export async function enforceRateLimit(
  c: Context<AppEnvironment>,
  options: RateLimitOptions,
): Promise<Response | null> {
  const limiter = services(c).rateLimiter;
  if (!limiter) return null;
  const result = await limiter.consume(
    options.bucket,
    options.rateLimitKey ?? getClientAddress(c),
    options.limit,
    options.windowSeconds,
    options.identity,
  );
  if (result.allowed) return null;
  c.header(
    "Retry-After",
    String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
  );
  return c.json({ error: "Too many requests" }, 429);
}

function requestSpecificLimit(
  method: string,
  pathname: string,
): RateLimitOptions | null {
  if (
    method === "GET" &&
    (pathname === "/api/community/exchange/map/config" ||
      pathname === "/api/community/exchange/map/offices")
  ) {
    return FUDABA_MAP_READ_LIMIT;
  }
  if (
    ["PUT", "DELETE"].includes(method) &&
    /^\/api\/community\/exchange\/me\/offices\/[^/]+\/location$/.test(
      pathname,
    )
  ) {
    return FUDABA_LOCATION_WRITE_LIMIT;
  }
  if (
    (method === "PUT" && (
      pathname.startsWith("/api/community/exchange/uploads/") ||
      /^\/api\/community\/exchange\/me\/offices\/[^/]+\/cover$/.test(
        pathname,
      )
    )) ||
    (method === "POST" && pathname === "/api/community/exchange/cards")
  ) {
    return FUDABA_UPLOAD_ATTEMPT_LIMIT;
  }
  if (
    ["POST", "PUT", "DELETE"].includes(method) &&
    (pathname === "/api/platform/me" ||
      pathname.startsWith("/api/community/exchange/"))
  ) {
    return FUDABA_WRITE_ATTEMPT_LIMIT;
  }
  if (
    method === "POST" &&
    pathname === "/api/platform/auth/refresh"
  ) {
    return PLATFORM_AUTH_REFRESH_LIMIT;
  }
  if (method === "POST" && pathname === "/api/platform/auth/login") {
    return PLATFORM_AUTH_LOGIN_LIMIT;
  }
  if (method === "POST" && pathname === "/api/platform/auth/register") {
    return PLATFORM_AUTH_REGISTER_LIMIT;
  }
  if (
    method === "POST" &&
    pathname === "/api/platform/auth/register/verification-code"
  ) {
    return PLATFORM_AUTH_EMAIL_VERIFICATION_LIMIT;
  }
  if (
    method === "POST" &&
    ["/api/login", "/api/admin/login", "/api/admin/auth/login"].includes(
      pathname,
    )
  ) {
    return AUTH_LOGIN_LIMIT;
  }
  if (
    (method === "POST" || method === "DELETE") &&
    (pathname === "/api/emojis" || pathname === "/api/reactions")
  ) {
    return REACTION_LIMIT;
  }
  return null;
}

export function requestRateLimit(): MiddlewareHandler<AppEnvironment> {
  return async (c, next) => {
    const pathname = validatedRequestPath(c);
    if (!isDynamicBusinessRequest(c.req.method, pathname)) return next();
    const globalLimited = await enforceRateLimit(c, GLOBAL_REQUEST_LIMIT);
    if (globalLimited) return globalLimited;
    if (c.req.method === "POST" && pathname === "/eventchronicle/upload") {
      const idempotencyKey = chronicleUploadIdempotencyKey(c.req.raw);
      const attemptLimited = await enforceRateLimit(
        c,
        CHRONICLE_UPLOAD_ATTEMPT_LIMIT,
      );
      if (attemptLimited) return attemptLimited;
      const writeLimited = await enforceRateLimit(c, {
        ...CHRONICLE_UPLOAD_WRITE_LIMIT,
        ...(idempotencyKey
          ? {
              identity: {
                operation: "chronicle:upload:write",
                identity: idempotencyKey,
              },
            }
          : {}),
      });
      if (writeLimited) return writeLimited;
    }
    const specific = requestSpecificLimit(c.req.method, pathname);
    if (specific) {
      const specificLimited = await enforceRateLimit(c, specific);
      if (specificLimited) return specificLimited;
    }
    return next();
  };
}
