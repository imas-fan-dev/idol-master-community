import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getPlatformProfile,
  loginPlatform,
  platformLoginInputSchema,
  platformLoginPasswordSchema,
  platformPasswordSchema,
  platformProfileResponseSchema,
  platformProfileUpdateSchema,
  platformRegistrationVerificationInputSchema,
  platformRegisterInputSchema,
  registerPlatform,
  sendPlatformRegistrationVerificationCode,
  updatePlatformProfile,
  uploadPlatformAvatar,
} from "~/lib/api/endpoints/platform"
import { CSRF_HEADER_NAME } from "~/lib/api/request"

const profile = {
  displayName: "Platform Producer",
  avatarUrl: "/api/platform/me/avatar?v=1000",
  homeCity: "上海",
  bio: "Profile bio",
  updatedAt: 1000,
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "ims_platform_csrf=; Max-Age=0; path=/"
})

describe("Platform profile API contracts", () => {
  it("strictly normalizes Platform login and registration inputs", () => {
    expect(
      platformLoginInputSchema.parse({
        email: "  Producer@Example.COM ",
        password: "correct-horse-battery",
      })
    ).toEqual({
      email: "producer@example.com",
      password: "correct-horse-battery",
    })
    expect(
      platformRegisterInputSchema.parse({
        email: "NEW@Example.com",
        password: "correct-horse-battery",
        displayName: "  新制作人  ",
        code: "012345",
      })
    ).toEqual({
      email: "new@example.com",
      password: "correct-horse-battery",
      displayName: "新制作人",
      code: "012345",
    })
    expect(
      platformLoginInputSchema.parse({
        email: " Legacy@@Example.COM ",
        password: " legacy-password ",
      })
    ).toEqual({
      email: "legacy@@example.com",
      password: "legacy-password",
    })
    expect(
      platformRegisterInputSchema.safeParse({
        email: "legacy@@example.com",
        password: "legacy-password",
        displayName: "Legacy Producer",
        code: "012345",
      }).success
    ).toBe(false)
    expect(() =>
      platformLoginInputSchema.parse({
        email: "producer@example.com",
        password: "too-short",
        extra: true,
      })
    ).toThrow()
    expect(() =>
      platformRegisterInputSchema.parse({
        email: "producer@example.com",
        password: "correct-horse-battery",
        displayName: "Producer",
        code: "12345a",
      })
    ).toThrow()
  })

  it("limits new passwords without blocking migrated PBKDF2 credentials", () => {
    expect(platformPasswordSchema.safeParse("12345678").success).toBe(true)
    expect(platformPasswordSchema.safeParse("1234567").success).toBe(false)
    expect(platformPasswordSchema.safeParse("a".repeat(72)).success).toBe(true)
    expect(platformPasswordSchema.safeParse("a".repeat(73)).success).toBe(false)
    expect(platformPasswordSchema.safeParse("密".repeat(24)).success).toBe(true)
    expect(platformPasswordSchema.safeParse("密".repeat(25)).success).toBe(
      false
    )
    expect(platformLoginPasswordSchema.parse(" legacy ")).toBe("legacy")
    expect(platformLoginPasswordSchema.safeParse("x").success).toBe(true)
    expect(platformLoginPasswordSchema.safeParse("密".repeat(25)).success).toBe(
      true
    )
    expect(platformLoginPasswordSchema.safeParse("x".repeat(129)).success).toBe(
      false
    )
  })

  it("posts normalized login, verification, and registration inputs", async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://ims.test").pathname
        requests.push({
          path,
          body: JSON.parse(String(init?.body)),
        })
        if (path.endsWith("verification-code")) {
          return Response.json(
            { success: true, retryAfterSeconds: 60 },
            { status: 202 }
          )
        }
        return Response.json(
          {
            success: true,
            account: { id: "platform-owner", status: "active" },
            profile: {
              displayName: path.endsWith("register") ? "新制作人" : "制作人",
              avatarUrl: null,
              homeCity: null,
              bio: "",
            },
          },
          { status: path.endsWith("register") ? 201 : 200 }
        )
      })
    )

    await loginPlatform({
      email: "  Producer@Example.com ",
      password: "correct-horse-battery",
    }).send()
    await sendPlatformRegistrationVerificationCode({
      email: "  New@Example.com ",
    }).send()
    await registerPlatform({
      email: "  New@Example.com ",
      password: "correct-horse-battery",
      displayName: "  新制作人  ",
      code: "012345",
    }).send()

    expect(requests).toEqual([
      {
        path: "/api/platform/auth/login",
        body: {
          email: "producer@example.com",
          password: "correct-horse-battery",
        },
      },
      {
        path: "/api/platform/auth/register/verification-code",
        body: {
          email: "new@example.com",
        },
      },
      {
        path: "/api/platform/auth/register",
        body: {
          email: "new@example.com",
          password: "correct-horse-battery",
          displayName: "新制作人",
          code: "012345",
        },
      },
    ])
    expect(
      platformRegistrationVerificationInputSchema.parse({
        email: " Producer@Example.COM ",
      })
    ).toEqual({ email: "producer@example.com" })
  })

  it("parses the exact owner profile projection and normalizes submissions", () => {
    expect(
      platformProfileResponseSchema.parse({
        success: true,
        account: { id: "platform-owner", status: "active" },
        profile,
        capabilities: { fudabaWrite: true },
      }).profile.updatedAt
    ).toBe(1000)

    expect(() =>
      platformProfileResponseSchema.parse({
        success: true,
        account: { id: "platform-owner", status: "active" },
        profile: { ...profile, avatarObjectKey: "protected/avatar.webp" },
        capabilities: { fudabaWrite: true },
      })
    ).toThrow()

    expect(
      platformProfileUpdateSchema.parse({
        displayName: "  Updated Owner  ",
        homeCity: "   ",
        bio: "  Updated bio  ",
        expectedUpdatedAt: 1000,
      })
    ).toEqual({
      displayName: "Updated Owner",
      homeCity: null,
      bio: "Updated bio",
      expectedUpdatedAt: 1000,
    })
  })

  it("uses Platform auth for reads and Platform CSRF for JSON writes", async () => {
    document.cookie = "ims_platform_csrf=profile-csrf; path=/"
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://ims.test")
        requests.push({ url: url.pathname, init })
        if (init?.method === "GET") {
          return Response.json({
            success: true,
            account: { id: "platform-owner", status: "active" },
            profile,
            capabilities: { fudabaWrite: false },
          })
        }
        return Response.json({
          success: true,
          profile: {
            ...profile,
            displayName: "Updated Owner",
            updatedAt: 1001,
          },
        })
      })
    )

    await expect(getPlatformProfile().send()).resolves.toMatchObject({
      profile: { displayName: "Platform Producer" },
    })
    await expect(
      updatePlatformProfile({
        displayName: " Updated Owner ",
        homeCity: null,
        bio: "Updated bio",
        expectedUpdatedAt: 1000,
      }).send()
    ).resolves.toMatchObject({
      profile: { displayName: "Updated Owner", updatedAt: 1001 },
    })

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/platform/me", "GET"],
      ["/api/platform/me", "PUT"],
    ])
    expect(
      new Headers(requests[0]?.init?.headers).get(CSRF_HEADER_NAME)
    ).toBeNull()
    expect(new Headers(requests[1]?.init?.headers).get(CSRF_HEADER_NAME)).toBe(
      "profile-csrf"
    )
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      displayName: "Updated Owner",
      homeCity: null,
      bio: "Updated bio",
      expectedUpdatedAt: 1000,
    })
  })

  it("uploads avatars as multipart PUT requests with revision fencing", async () => {
    document.cookie = "ims_platform_csrf=avatar-csrf; path=/"
    let request: RequestInit | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(input), "http://ims.test").pathname).toBe(
          "/api/community/exchange/uploads/avatar"
        )
        request = init
        return Response.json({
          success: true,
          profile: { ...profile, updatedAt: 1001 },
        })
      })
    )
    const image = new File(["avatar"], "avatar.png", { type: "image/png" })

    await expect(
      uploadPlatformAvatar({ image, expectedUpdatedAt: 1000 }).send()
    ).resolves.toMatchObject({ profile: { updatedAt: 1001 } })

    expect(request?.method).toBe("PUT")
    expect(new Headers(request?.headers).get(CSRF_HEADER_NAME)).toBe(
      "avatar-csrf"
    )
    expect(request?.body).toBeInstanceOf(FormData)
    const form = request?.body as FormData
    expect(form.get("image")).toBe(image)
    expect(form.get("expectedUpdatedAt")).toBe("1000")
  })
})
