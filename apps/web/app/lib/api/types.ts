export type ApiResponseType =
  | "auto"
  | "json"
  | "text"
  | "blob"
  | "arrayBuffer"
  | "raw"

export type ApiAuthRealm = "backoffice" | "platform"

export interface ApiMethodMeta {
  /** Identity realm allowed to process this request. */
  authRealm?: ApiAuthRealm
  /** Alova token-authentication role for login, logout, and refresh requests. */
  authRole?: "login" | "logout" | "refreshToken" | null
  /** Read the current realm's CSRF cookie and send it as X-CSRFToken. */
  csrf?: boolean
  /** Override content-type based response parsing for exceptional endpoints. */
  responseType?: ApiResponseType
  /** Use only when an endpoint intentionally returns a failure-shaped payload as data. */
  skipBusinessErrorCheck?: boolean
}

export interface ApiRequestContext {
  method?: string
  url?: string
  meta?: ApiMethodMeta
}

export function withBackofficeAuth(
  meta: Omit<ApiMethodMeta, "authRealm"> = {}
): ApiMethodMeta {
  return { ...meta, authRealm: "backoffice" }
}

export function withBackofficeCsrf(
  meta: Omit<ApiMethodMeta, "authRealm" | "csrf"> = {}
): ApiMethodMeta {
  return { ...meta, authRealm: "backoffice", csrf: true }
}

export function withPlatformAuth(
  meta: Omit<ApiMethodMeta, "authRealm"> = {}
): ApiMethodMeta {
  return { ...meta, authRealm: "platform" }
}

export function withPlatformCsrf(
  meta: Omit<ApiMethodMeta, "authRealm" | "csrf"> = {}
): ApiMethodMeta {
  return { ...meta, authRealm: "platform", csrf: true }
}
