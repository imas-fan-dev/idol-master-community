import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import AdminCommunityExchangePage from "~/pages/admin/community/exchange/admin-community-exchange-page"

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: toastMocks }))

const pendingReview = {
  officeId: "office-1",
  officeName: "上海周末交换事务所",
  city: "上海",
  ownerAccountId: "platform-owner-1",
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional",
  },
  reviewState: "pending",
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
})

describe("AdminCommunityExchangePage", () => {
  it("filters the three review states and renders review metadata", async () => {
    const requestedStates: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        const state = new URL(request.url).searchParams.get("state") ?? ""
        requestedStates.push(state)
        return Response.json({
          items:
            state === "pending"
              ? [pendingReview]
              : state === "published"
                ? [
                    {
                      ...pendingReview,
                      reviewState: "published",
                      reviewedAt: "2026-08-03T02:00:00.000Z",
                      reviewedBy: 7,
                      reviewNote: "区域精度符合公开要求",
                    },
                  ]
                : [],
        })
      })
    )
    const user = userEvent.setup()

    render(<AdminCommunityExchangePage />)

    expect(await screen.findByText("上海周末交换事务所")).toBeVisible()
    expect(screen.getByText("31.2°, 121.5°")).toBeVisible()
    expect(screen.getByText("platform-owner-1")).toBeVisible()
    expect(screen.getByText("0.1° 区域精度")).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "已发布" }))
    expect(await screen.findByText("管理员 #7")).toBeVisible()
    expect(screen.getByText("区域精度符合公开要求")).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "已拒绝" }))
    expect(await screen.findByText("已拒绝队列为空")).toBeVisible()
    expect(requestedStates).toEqual(["pending", "published", "rejected"])
  })

  it("requires a rejection reason and submits it with CSRF and revision", async () => {
    document.cookie = "ims_admin_csrf=location-page-csrf; path=/"
    const requests: Request[] = []
    let reviewed = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        requests.push(request.clone())
        if (request.method === "PUT") {
          reviewed = true
          return Response.json({
            success: true,
            officeLocation: {
              officeId: pendingReview.officeId,
              location: pendingReview.location,
              reviewState: "rejected",
              revision: 4,
              submittedAt: pendingReview.submittedAt,
              reviewedAt: "2026-08-03T02:00:00.000Z",
              reviewNote: "公开范围不合适",
            },
          })
        }
        return Response.json({ items: reviewed ? [] : [pendingReview] })
      })
    )
    const user = userEvent.setup()

    render(<AdminCommunityExchangePage />)
    await screen.findByText("上海周末交换事务所")

    await user.click(screen.getByRole("button", { name: "拒绝" }))
    expect(screen.getByText("拒绝公开位置时必须填写审核理由")).toBeVisible()
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(
      0
    )

    await user.type(screen.getByLabelText("审核备注"), "公开范围不合适")
    await user.click(screen.getByRole("button", { name: "拒绝" }))

    await screen.findByText("待审核队列为空")
    const mutation = requests.find((request) => request.method === "PUT")
    expect(mutation?.headers.get("X-CSRFToken")).toBe("location-page-csrf")
    await expect(mutation?.json()).resolves.toEqual({
      decision: "reject",
      expectedRevision: 3,
      note: "公开范围不合适",
    })
    expect(toastMocks.success).toHaveBeenCalledWith(
      "“上海周末交换事务所”的位置已拒绝"
    )
  })

  it("keeps the review note after a revision conflict and refresh", async () => {
    document.cookie = "ims_admin_csrf=location-conflict-csrf; path=/"
    let listRequests = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        if (request.method === "PUT") {
          return Response.json(
            {
              success: false,
              code: "FUDABA_OFFICE_LOCATION_CONFLICT",
              revision: 4,
            },
            { status: 409 }
          )
        }
        listRequests += 1
        return Response.json({ items: [pendingReview] })
      })
    )
    const user = userEvent.setup()

    render(<AdminCommunityExchangePage />)
    const note = await screen.findByLabelText("审核备注")
    await user.type(note, "需要重新核对区域")
    await user.click(screen.getByRole("button", { name: "拒绝" }))

    expect(await screen.findByText("审核记录已变化")).toBeVisible()
    expect(note).toHaveValue("需要重新核对区域")
    expect(toastMocks.error).toHaveBeenCalledWith(
      "审核记录已变化，请刷新后重试"
    )

    await user.click(screen.getByRole("button", { name: "刷新队列" }))
    await waitFor(() => expect(listRequests).toBe(2))
    expect(screen.getByLabelText("审核备注")).toHaveValue("需要重新核对区域")
    expect(screen.queryByText("审核记录已变化")).not.toBeInTheDocument()
  })

  it("tracks concurrent review requests independently", async () => {
    document.cookie = "ims_admin_csrf=location-concurrent-csrf; path=/"
    const firstMutation = deferred<Response>()
    const secondMutation = deferred<Response>()
    const completed = new Set<string>()
    const secondReview = {
      ...pendingReview,
      officeId: "office-2",
      officeName: "杭州周末交换事务所",
      ownerAccountId: "platform-owner-2",
      location: {
        ...pendingReview.location,
        latitude: 30.3,
        longitude: 120.2,
      },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        if (request.method === "PUT") {
          return new URL(request.url).pathname.endsWith("/office-1")
            ? firstMutation.promise
            : secondMutation.promise
        }
        return Response.json({
          items: [pendingReview, secondReview].filter(
            (item) => !completed.has(item.officeId)
          ),
        })
      })
    )
    const user = userEvent.setup()

    render(<AdminCommunityExchangePage />)
    const firstCard = await screen.findByRole("article", {
      name: "上海周末交换事务所位置审核",
    })
    const secondCard = screen.getByRole("article", {
      name: "杭州周末交换事务所位置审核",
    })
    const firstPublish = within(firstCard).getByRole("button", {
      name: "发布",
    })
    const secondPublish = within(secondCard).getByRole("button", {
      name: "发布",
    })

    await user.click(firstPublish)
    await user.click(secondPublish)
    expect(firstPublish).toBeDisabled()
    expect(secondPublish).toBeDisabled()

    completed.add("office-1")
    firstMutation.resolve(
      Response.json({
        success: true,
        officeLocation: {
          officeId: pendingReview.officeId,
          location: pendingReview.location,
          reviewState: "published",
          revision: 4,
          submittedAt: pendingReview.submittedAt,
          reviewedAt: "2026-08-03T02:00:00.000Z",
          reviewNote: "",
        },
      })
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("article", {
          name: "上海周末交换事务所位置审核",
        })
      ).not.toBeInTheDocument()
    )
    expect(secondPublish).toBeDisabled()

    completed.add("office-2")
    secondMutation.resolve(
      Response.json({
        success: true,
        officeLocation: {
          officeId: secondReview.officeId,
          location: secondReview.location,
          reviewState: "published",
          revision: 4,
          submittedAt: secondReview.submittedAt,
          reviewedAt: "2026-08-03T02:01:00.000Z",
          reviewNote: "",
        },
      })
    )
    expect(await screen.findByText("待审核队列为空")).toBeVisible()
  })

  it("shows a load error and retries to the empty state", async () => {
    let attempt = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1
        if (attempt === 1) throw new TypeError("network unavailable")
        return Response.json({ items: [] })
      })
    )
    const user = userEvent.setup()

    render(<AdminCommunityExchangePage />)

    expect(await screen.findByText("无法读取审核队列")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(await screen.findByText("待审核队列为空")).toBeVisible()
  })
})
