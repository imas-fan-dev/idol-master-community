import { afterEach, describe, expect, it, vi } from "vitest"

import { adminApiClient } from "~/lib/api/admin-client"
import { apiClient } from "~/lib/api/client"
import {
  getPlatformSession,
  hasPlatformSessionHint,
  logoutPlatform,
} from "~/lib/api/endpoints/platform"
import { platformApiClient } from "~/lib/api/platform-client"
import {
  applyApiRequestPolicy,
  CSRF_HEADER_NAME,
  PLATFORM_CSRF_COOKIE_NAME,
} from "~/lib/api/request"
import { withPlatformAuth, withPlatformCsrf } from "~/lib/api/types"

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "ims_platform_csrf=; Max-Age=0; path=/"
})

describe("Platform API boundary", () => {
  it("uses only the Platform CSRF cookie and rejects client realm misuse", () => {
    const request = {
      config: { headers: {} as Record<string, unknown> },
      meta: withPlatformCsrf(),
      type: "POST",
      url: "/api/platform/auth/logout",
    }

    applyApiRequestPolicy(request, {
      authRealm: "platform",
      csrfCookieName: PLATFORM_CSRF_COOKIE_NAME,
      cookieSource:
        "ims_admin_csrf=admin-token; ims_platform_csrf=platform-token",
    })

    expect(request.config.headers).toEqual({
      [CSRF_HEADER_NAME]: "platform-token",
    })
    expect(() =>
      applyApiRequestPolicy(
        {
          config: { headers: {} },
          meta: withPlatformAuth(),
          type: "GET",
          url: "/api/platform/auth/session",
        },
        { authRealm: "backoffice" }
      )
    ).toThrowError(/platform request cannot use the backoffice API client/)
    expect(() =>
      applyApiRequestPolicy({
        config: { headers: {} },
        meta: withPlatformAuth(),
        type: "GET",
        url: "/api/platform/auth/session",
      })
    ).toThrowError(/platform request cannot use the public API client/)
  })

  it("uses the readable Platform CSRF cookie as the session hint", () => {
    expect(hasPlatformSessionHint()).toBe(false)
    document.cookie = "ims_platform_csrf=platform-session-hint; path=/"
    expect(hasPlatformSessionHint()).toBe(true)
  })

  it("coalesces concurrent Platform 401 responses and replays each once", async () => {
    document.cookie = "ims_platform_csrf=platform-refresh-csrf; path=/"
    let sessionRequests = 0
    let refreshRequests = 0
    let refreshHeaders: Headers | undefined
    let releaseInitialRequests!: () => void
    const initialRequestsReady = new Promise<void>((resolve) => {
      releaseInitialRequests = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        if (pathname === "/api/platform/auth/refresh") {
          refreshRequests += 1
          refreshHeaders = new Headers(init?.headers)
          return Response.json({
            success: true,
            account: { id: "platform-1", status: "active" },
            profile: {
              displayName: "Platform Producer",
              avatarUrl: null,
              homeCity: null,
              bio: "",
            },
          })
        }
        if (pathname === "/api/platform/auth/session") {
          sessionRequests += 1
          if (sessionRequests <= 2) {
            if (sessionRequests === 2) releaseInitialRequests()
            await initialRequestsReady
            return Response.json(
              { success: false, code: "PLATFORM_SESSION_INVALID" },
              { status: 401 }
            )
          }
          return Response.json({
            success: true,
            account: { id: "platform-1", status: "active" },
            profile: {
              displayName: "Platform Producer",
              avatarUrl: null,
              homeCity: null,
              bio: "",
            },
          })
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    const [first, second] = await Promise.all([
      getPlatformSession().send(),
      platformApiClient
        .Get("/api/platform/auth/session?request=second", {
          meta: withPlatformAuth(),
        })
        .send(),
    ])

    expect(first.profile.displayName).toBe("Platform Producer")
    expect(second).toMatchObject({
      profile: { displayName: "Platform Producer" },
    })
    expect(refreshRequests).toBe(1)
    expect(sessionRequests).toBe(4)
    expect(refreshHeaders?.get(CSRF_HEADER_NAME)).toBe("platform-refresh-csrf")
  })

  it("settles every waiter when Platform refresh fails", async () => {
    document.cookie = "ims_platform_csrf=expired-platform-csrf; path=/"
    let sessionRequests = 0
    let refreshRequests = 0
    let releaseInitialRequests!: () => void
    const initialRequestsReady = new Promise<void>((resolve) => {
      releaseInitialRequests = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        if (pathname === "/api/platform/auth/refresh") {
          refreshRequests += 1
          return Response.json(
            { success: false, code: "PLATFORM_SESSION_INVALID" },
            { status: 401 }
          )
        }
        if (pathname === "/api/platform/auth/session") {
          sessionRequests += 1
          if (sessionRequests <= 2) {
            if (sessionRequests === 2) releaseInitialRequests()
            await initialRequestsReady
          }
          return Response.json(
            { success: false, code: "PLATFORM_SESSION_INVALID" },
            { status: 401 }
          )
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    const requests = [
      getPlatformSession().send(),
      platformApiClient
        .Get("/api/platform/auth/session?request=second", {
          meta: withPlatformAuth(),
        })
        .send(),
    ]
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 250)
    })
    const result = await Promise.race([Promise.allSettled(requests), timeout])

    expect(result).not.toBe("timeout")
    expect(result).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ])
    expect(refreshRequests).toBe(1)
    expect(sessionRequests).toBe(4)
  })

  it("refreshes again after an offline replay fails and the network recovers", async () => {
    document.cookie = "ims_platform_csrf=network-recovery-csrf; path=/"
    let sessionRequests = 0
    let refreshRequests = 0

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        if (pathname === "/api/platform/auth/refresh") {
          refreshRequests += 1
          if (refreshRequests === 1) {
            throw new TypeError("refresh network unavailable")
          }
          return Response.json({ success: true })
        }
        if (pathname === "/api/platform/auth/session") {
          sessionRequests += 1
          if (sessionRequests === 2) {
            throw new TypeError("replay network unavailable")
          }
          if (sessionRequests === 1 || sessionRequests === 3) {
            return Response.json(
              { success: false, code: "PLATFORM_SESSION_INVALID" },
              { status: 401 }
            )
          }
          return Response.json({
            success: true,
            account: { id: "platform-recovered", status: "active" },
            profile: {
              displayName: "Recovered Producer",
              avatarUrl: null,
              homeCity: null,
              bio: "",
            },
          })
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    await expect(getPlatformSession().send()).rejects.toThrow(/网络请求失败/)
    await expect(getPlatformSession().send()).resolves.toMatchObject({
      profile: { displayName: "Recovered Producer" },
    })
    expect(refreshRequests).toBe(2)
    expect(sessionRequests).toBe(4)
  })

  it("never lets public or Backoffice clients execute Platform methods", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      apiClient
        .Get("/api/platform/auth/session", { meta: withPlatformAuth() })
        .send()
    ).rejects.toThrow(/platform request cannot use the public API client/)
    await expect(
      adminApiClient
        .Get("/api/platform/auth/session", { meta: withPlatformAuth() })
        .send()
    ).rejects.toThrow(/platform request cannot use the backoffice API client/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("marks logout as a Platform-only mutation", async () => {
    document.cookie = "ims_platform_csrf=logout-platform-csrf; path=/"
    let logoutHeaders: Headers | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        logoutHeaders = new Headers(init?.headers)
        return Response.json({ success: true })
      })
    )

    await expect(logoutPlatform().send()).resolves.toEqual({ success: true })
    expect(logoutHeaders?.get(CSRF_HEADER_NAME)).toBe("logout-platform-csrf")
  })
})
