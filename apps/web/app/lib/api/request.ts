import { ApiError } from "./api-error"
import { readCookie } from "./cookies"
import type { ApiAuthRealm, ApiMethodMeta } from "./types"

export const BACKOFFICE_CSRF_COOKIE_NAME = "ims_admin_csrf"
export const LEGACY_BACKOFFICE_CSRF_COOKIE_NAME = "csrf_token"
export const PLATFORM_CSRF_COOKIE_NAME = "ims_platform_csrf"
export const CSRF_HEADER_NAME = "X-CSRFToken"

interface ApiRequestPolicyOptions {
  authRealm?: ApiAuthRealm
  csrfCookieName?: string
  csrfFallbackCookieNames?: readonly string[]
  cookieSource?: string
}

interface ApiRequestPolicyTarget {
  config: {
    credentials?: RequestCredentials
    headers: Record<string, unknown>
  }
  meta?: ApiMethodMeta
  type?: string
  url?: string
}

function setHeader(
  headers: Record<string, unknown>,
  name: string,
  value: string
): void {
  const normalizedName = name.toLowerCase()
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === normalizedName) {
      delete headers[headerName]
    }
  }
  headers[name] = value
}

export function applyApiRequestPolicy(
  request: ApiRequestPolicyTarget,
  options: ApiRequestPolicyOptions = {}
): void {
  request.config.credentials = "same-origin"

  if (request.meta?.authRealm && request.meta.authRealm !== options.authRealm) {
    throw new Error(
      `${request.meta.authRealm} request cannot use the ${options.authRealm ?? "public"} API client`
    )
  }

  if (!request.meta?.csrf) {
    return
  }

  if (!options.csrfCookieName) {
    throw new Error("CSRF request requires an authentication realm")
  }

  const csrfToken = [
    options.csrfCookieName,
    ...(options.csrfFallbackCookieNames ?? []),
  ].reduce<string | undefined>(
    (token, cookieName) =>
      token ?? readCookie(cookieName, options.cookieSource),
    undefined
  )
  if (!csrfToken) {
    throw new ApiError("登录会话缺少 CSRF 令牌，请刷新页面后重试", {
      kind: "csrf",
      code: "CSRF_TOKEN_MISSING",
      method: request.type,
      url: request.url,
    })
  }

  setHeader(request.config.headers, CSRF_HEADER_NAME, csrfToken)
}
