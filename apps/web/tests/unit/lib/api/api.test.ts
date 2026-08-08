import { afterEach, describe, expect, it, vi } from "vitest"

import { adminApiClient } from "~/lib/api/admin-client"
import { ApiError, normalizeRequestError } from "~/lib/api/api-error"
import { apiClient } from "~/lib/api/client"
import { readCookie } from "~/lib/api/cookies"
import {
  getAdminSession,
  hasBackofficeSessionHint,
  loginAdmin,
  logoutAdmin,
} from "~/lib/api/endpoints/admin"
import {
  applyApiRequestPolicy,
  BACKOFFICE_CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  LEGACY_BACKOFFICE_CSRF_COOKIE_NAME,
} from "~/lib/api/request"
import { handleApiResponse } from "~/lib/api/response"
import { withBackofficeAuth, withBackofficeCsrf } from "~/lib/api/types"

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
  document.cookie = "csrf_token=; Max-Age=0; path=/"
})

describe("API request policy", () => {
  it("decodes cookie values without truncating embedded equals signs", () => {
    expect(
      readCookie(
        "ims_admin_csrf",
        "theme=dark; ims_admin_csrf=a%2Fb%3D%3D; other=1"
      )
    ).toBe("a/b==")
  })

  it("uses the current CSRF cookie and enforces same-origin credentials", () => {
    const request = {
      config: {
        credentials: "omit" as RequestCredentials,
        headers: { "x-csrftoken": "stale", Accept: "application/json" },
      },
      meta: withBackofficeCsrf(),
      type: "POST",
      url: "/api/admin/news",
    }

    applyApiRequestPolicy(request, {
      authRealm: "backoffice",
      csrfCookieName: BACKOFFICE_CSRF_COOKIE_NAME,
      csrfFallbackCookieNames: [LEGACY_BACKOFFICE_CSRF_COOKIE_NAME],
      cookieSource: "csrf_token=legacy-token; ims_admin_csrf=fresh-token",
    })

    expect(request.config.credentials).toBe("same-origin")
    expect(request.config.headers).toEqual({
      Accept: "application/json",
      [CSRF_HEADER_NAME]: "fresh-token",
    })
  })

  it("falls back to the legacy Backoffice CSRF cookie during rolling upgrades", () => {
    const request = {
      config: { headers: {} as Record<string, unknown> },
      meta: withBackofficeCsrf({ authRole: "refreshToken" }),
      type: "POST",
      url: "/api/admin/auth/refresh",
    }

    applyApiRequestPolicy(request, {
      authRealm: "backoffice",
      csrfCookieName: BACKOFFICE_CSRF_COOKIE_NAME,
      csrfFallbackCookieNames: [LEGACY_BACKOFFICE_CSRF_COOKIE_NAME],
      cookieSource: "csrf_token=legacy-upgrade-token",
    })

    expect(request.config.headers).toEqual({
      [CSRF_HEADER_NAME]: "legacy-upgrade-token",
    })
  })

  it("uses a legacy CSRF cookie as a Backoffice session hint during upgrades", () => {
    document.cookie = "csrf_token=legacy-session-hint; path=/"

    expect(hasBackofficeSessionHint()).toBe(true)
  })

  it("fails before sending a protected request when the CSRF cookie is missing", () => {
    const applyWithoutToken = () =>
      applyApiRequestPolicy(
        {
          config: { headers: {} },
          meta: withBackofficeCsrf(),
          type: "DELETE",
          url: "/api/admin/cards/1",
        },
        {
          authRealm: "backoffice",
          csrfCookieName: BACKOFFICE_CSRF_COOKIE_NAME,
          cookieSource: "theme=dark",
        }
      )

    expect(applyWithoutToken).toThrowError(ApiError)
    expect(applyWithoutToken).toThrowError(
      expect.objectContaining({
        kind: "csrf",
        code: "CSRF_TOKEN_MISSING",
      })
    )
  })

  it("rejects a backoffice request sent through the public client policy", () => {
    expect(() =>
      applyApiRequestPolicy({
        config: { headers: {} },
        meta: withBackofficeAuth(),
        type: "GET",
        url: "/api/admin/auth/session",
      })
    ).toThrowError(/backoffice request cannot use the public API client/)
  })
})

describe("API response policy", () => {
  it("parses JSON responses", async () => {
    const response = Response.json({ success: true, user: { dept: "op" } })

    await expect(handleApiResponse(response)).resolves.toEqual({
      success: true,
      user: { dept: "op" },
    })
  })

  it("normalizes a non-2xx Hono payload into an HTTP ApiError", async () => {
    const response = Response.json({ error: "活动不存在" }, { status: 404 })

    await expect(
      handleApiResponse(response, { method: "GET", url: "/api/events/7" })
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "http",
      status: 404,
      code: "HTTP_404",
      message: "活动不存在",
      payload: { error: "活动不存在" },
    })
  })

  it("normalizes an HTTP 200 business failure", async () => {
    const response = Response.json({ success: false, msg: "数据库错误" })

    await expect(handleApiResponse(response)).rejects.toMatchObject({
      kind: "business",
      status: 200,
      code: "BUSINESS_ERROR",
      message: "数据库错误",
    })
  })

  it("allows an explicitly opted-out failure-shaped payload", async () => {
    const payload = { status: "error", msg: "上游结果" }
    const response = Response.json(payload)

    await expect(
      handleApiResponse(response, { meta: { skipBusinessErrorCheck: true } })
    ).resolves.toEqual(payload)
  })

  it("reports malformed JSON as a parse error", async () => {
    const response = new Response("{not-json", {
      headers: { "content-type": "application/json" },
    })

    await expect(handleApiResponse(response)).rejects.toMatchObject({
      kind: "parse",
      code: "RESPONSE_PARSE_ERROR",
    })
  })

  it("keeps non-JSON successful responses as text", async () => {
    const response = new Response("ok", {
      headers: { "content-type": "text/plain" },
    })

    await expect(handleApiResponse(response)).resolves.toBe("ok")
  })
})

describe("network errors", () => {
  it("preserves request cancellation as a distinct error kind", () => {
    expect(
      normalizeRequestError(new DOMException("aborted", "AbortError"), {
        method: "GET",
        url: "/api/news",
      })
    ).toMatchObject({
      kind: "aborted",
      code: "REQUEST_ABORTED",
      method: "GET",
      url: "/api/news",
    })
  })
})

describe("Alova access-token refresh", () => {
  it("uses the role-gated admin endpoint without refreshing a failed login", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input), "http://ims.test").pathname).toBe(
        "/api/admin/auth/login"
      )
      return Response.json(
        {
          success: false,
          message: "用户名或密码错误",
        },
        { status: 401 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(loginAdmin("reader", "password").send()).rejects.toMatchObject(
      {
        kind: "http",
        status: 401,
        message: "用户名或密码错误",
      }
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("does not refresh a public request that returns 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), "http://ims.test").pathname
      expect(pathname).toBe("/api/news")
      return Response.json(
        { success: false, message: "public request denied" },
        { status: 401 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(apiClient.Get("/api/news").send()).rejects.toMatchObject({
      kind: "http",
      status: 401,
      message: "public request denied",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("does not refresh or replay a failed admin logout", async () => {
    document.cookie = "ims_admin_csrf=logout-csrf; path=/"
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input), "http://ims.test").pathname).toBe(
        "/api/admin/auth/logout"
      )
      return Response.json(
        { success: false, message: "session expired" },
        { status: 401 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(logoutAdmin().send()).rejects.toMatchObject({
      kind: "http",
      status: 401,
      message: "session expired",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("sends the legacy CSRF cookie to the canonical logout during an upgrade", async () => {
    document.cookie = "csrf_token=legacy-logout-csrf; path=/"
    let logoutHeaders: Headers | undefined
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        logoutHeaders = new Headers(init?.headers)
        return Response.json({ success: true })
      }
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(logoutAdmin().send()).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(logoutHeaders?.get(CSRF_HEADER_NAME)).toBe("legacy-logout-csrf")
  })

  it("settles every request when a concurrent admin refresh fails", async () => {
    document.cookie = "ims_admin_csrf=expired-refresh-csrf; path=/"
    let checkRequests = 0
    let refreshRequests = 0
    let releaseInitialChecks!: () => void
    const initialChecksReady = new Promise<void>((resolve) => {
      releaseInitialChecks = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        if (pathname === "/api/admin/auth/refresh") {
          refreshRequests += 1
          return Response.json(
            { success: false, message: "refresh expired" },
            { status: 401 }
          )
        }
        if (pathname === "/api/admin/auth/session") {
          checkRequests += 1
          if (checkRequests <= 2) {
            if (checkRequests === 2) releaseInitialChecks()
            await initialChecksReady
          }
          return Response.json(
            { success: false, message: "token invalid" },
            { status: 401 }
          )
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    const requests = [
      getAdminSession().send(),
      adminApiClient
        .Get("/api/admin/auth/session?request=second", {
          meta: withBackofficeAuth(),
        })
        .send(),
    ]
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 250)
    })
    const result = await Promise.race([Promise.allSettled(requests), timeout])

    expect(result).not.toBe("timeout")
    expect(result).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ status: 401 }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ status: 401 }),
      }),
    ])
    expect(refreshRequests).toBe(1)
    expect(checkRequests).toBe(4)
  })

  it("coalesces concurrent 401 responses and replays both requests", async () => {
    document.cookie = "ims_admin_csrf=alova-refresh-csrf; path=/"
    let checkRequests = 0
    let refreshRequests = 0
    let refreshHeaders: Headers | undefined
    let releaseInitialChecks!: () => void
    const initialChecksReady = new Promise<void>((resolve) => {
      releaseInitialChecks = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        if (pathname === "/api/admin/auth/refresh") {
          refreshRequests += 1
          refreshHeaders = new Headers(init?.headers)
          return Response.json({ success: true })
        }
        if (pathname === "/api/admin/auth/session") {
          checkRequests += 1
          if (checkRequests <= 2) {
            if (checkRequests === 2) releaseInitialChecks()
            await initialChecksReady
            return Response.json(
              { success: false, message: "token无效" },
              { status: 401 }
            )
          }
          return Response.json({
            success: true,
            user: {
              id: 1,
              username: "alova-op",
              producername: "Alova Producer",
              dept: "op",
              adminRole: "admin",
            },
          })
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    const [first, second] = await Promise.all([
      getAdminSession().send(),
      adminApiClient
        .Get<{
          success: true
          user: { username: string }
        }>("/api/admin/auth/session?request=second", {
          meta: withBackofficeAuth(),
        })
        .send(),
    ])

    expect(first.user.username).toBe("alova-op")
    expect(second.user.username).toBe("alova-op")
    expect(refreshRequests).toBe(1)
    expect(checkRequests).toBe(4)
    expect(refreshHeaders?.get("X-CSRFToken")).toBe("alova-refresh-csrf")
  })
})
