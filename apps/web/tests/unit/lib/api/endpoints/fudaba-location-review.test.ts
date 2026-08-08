import { afterEach, describe, expect, it, vi } from "vitest"

import {
  fudabaLocationReviewListSchema,
  getFudabaLocationReviews,
  reviewFudabaLocation,
} from "~/lib/api/endpoints/fudaba-location-review"
import { CSRF_HEADER_NAME } from "~/lib/api/request"

const review = {
  officeId: "office-1",
  officeName: "上海周末交换事务所",
  city: "上海",
  ownerAccountId: "platform-owner-1",
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional" as const,
  },
  reviewState: "pending" as const,
  revision: 3,
  submittedAt: "2026-08-03T01:00:00.000Z",
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: "",
}

function requestFrom(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof Request
    ? input
    : new Request(new URL(String(input), "http://ims.test"), init)
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
})

describe("Fudaba location review API", () => {
  it("accepts only regional review projections", () => {
    expect(
      fudabaLocationReviewListSchema.parse({ items: [review] }).items[0]
        ?.officeName
    ).toBe("上海周末交换事务所")

    expect(() =>
      fudabaLocationReviewListSchema.parse({
        items: [
          {
            ...review,
            location: { ...review.location, latitude: 31.25 },
          },
        ],
      })
    ).toThrow(/0.1 degree grid/)
    expect(() =>
      fudabaLocationReviewListSchema.parse({
        items: [{ ...review, exactAddress: "不应进入运营 DTO" }],
      })
    ).toThrow()
  })

  it("loads a filtered queue with Backoffice auth", async () => {
    const requests: Request[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(requestFrom(input, init).clone())
        return Response.json({ items: [review] })
      })
    )

    await expect(
      getFudabaLocationReviews("rejected", 25).send()
    ).resolves.toMatchObject({ items: [{ officeId: "office-1" }] })

    const request = requests[0]
    const url = new URL(request!.url)
    expect(url.pathname).toBe("/api/admin/community/exchange/office-locations")
    expect(url.searchParams.get("state")).toBe("rejected")
    expect(url.searchParams.get("limit")).toBe("25")
    expect(request?.credentials).toBe("same-origin")
    expect(request?.headers.get(CSRF_HEADER_NAME)).toBeNull()
  })

  it("URL-encodes office IDs and sends CAS decisions with Backoffice CSRF", async () => {
    document.cookie = "ims_admin_csrf=location-review-csrf; path=/"
    let submitted: Request | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        submitted = requestFrom(input, init).clone()
        return Response.json({
          success: true,
          officeLocation: {
            officeId: "office /?#",
            location: review.location,
            reviewState: "rejected",
            revision: 4,
            submittedAt: review.submittedAt,
            reviewedAt: "2026-08-03T02:00:00.000Z",
            reviewNote: "公开范围不合适",
          },
        })
      })
    )

    await reviewFudabaLocation("office /?#", {
      decision: "reject",
      expectedRevision: 3,
      note: "公开范围不合适",
    }).send()

    expect(submitted?.method).toBe("PUT")
    expect(new URL(submitted!.url).pathname).toBe(
      "/api/admin/community/exchange/office-locations/office%20%2F%3F%23"
    )
    expect(submitted?.headers.get(CSRF_HEADER_NAME)).toBe(
      "location-review-csrf"
    )
    await expect(submitted?.json()).resolves.toEqual({
      decision: "reject",
      expectedRevision: 3,
      note: "公开范围不合适",
    })
  })
})
