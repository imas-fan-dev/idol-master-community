import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "~/lib/api"
import CommunityOfficePage from "~/pages/community/exchange/community-office-page"

const apiMocks = vi.hoisted(() => ({
  deleteFudabaCardPlacement: vi.fn(),
  getFudabaOffice: vi.fn(),
  getFudabaOwnerCards: vi.fn(),
  getFudabaSeries: vi.fn(),
  getPlatformProfile: vi.fn(),
  saveFudabaCardPlacement: vi.fn(),
  sendOwnerCards: vi.fn(),
  sendOffice: vi.fn(),
  sendPlacement: vi.fn(),
  sendProfile: vi.fn(),
  sendSeries: vi.fn(),
}))

const platformMocks = vi.hoisted(() => ({
  usePlatformSession: vi.fn(),
}))

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))

vi.mock("~/components/platform/platform-session-provider", () => ({
  usePlatformSession: platformMocks.usePlatformSession,
}))

vi.mock("sonner", () => ({ toast: toastMocks }))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    deleteFudabaCardPlacement: apiMocks.deleteFudabaCardPlacement,
    getFudabaOffice: apiMocks.getFudabaOffice,
    getFudabaOwnerCards: apiMocks.getFudabaOwnerCards,
    getFudabaSeries: apiMocks.getFudabaSeries,
    getPlatformProfile: apiMocks.getPlatformProfile,
    saveFudabaCardPlacement: apiMocks.saveFudabaCardPlacement,
  }
})

const placedCard = {
  id: "card-1",
  producerName: "春香P",
  displayName: "交换会用名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/brand/series/wall/765pro.webp",
  backImageUrl: "/brand/series/wall/cinderella-girls.webp",
  accent: "#f34e6c",
  bio: "",
  tradeNote: "现场交换",
  available: true,
  source: null,
  createdAt: "2026-08-02T08:00:00.000Z",
  interactions: {
    likes: 2,
    favorites: 1,
    viewerLiked: true,
    viewerFavorited: false,
  },
  viewerOwned: true,
  placement: {
    pinnedAt: "2026-08-02T09:00:00.000Z",
    x: 45,
    y: 52,
    rotation: -3,
    zIndex: 2,
    revision: 3,
    updatedAt: "2026-08-02T09:00:00.000Z",
  },
}

const ownerCard = {
  id: placedCard.id,
  producerName: placedCard.producerName,
  displayName: placedCard.displayName,
  seriesCode: placedCard.seriesCode,
  favoriteIdol: placedCard.favoriteIdol,
  frontImageUrl: placedCard.frontImageUrl,
  backImageUrl: placedCard.backImageUrl,
  accent: placedCard.accent,
  bio: placedCard.bio,
  tradeNote: placedCard.tradeNote,
  available: placedCard.available,
  mediaRightsStatus: "approved",
  publicationStatus: "published",
  revision: 2,
  createdAt: placedCard.createdAt,
  updatedAt: "2026-08-02T09:00:00.000Z",
}

const unplacedOwnerCard = {
  ...ownerCard,
  id: "card-2",
  displayName: "第二张公开名片",
  revision: 1,
  createdAt: "2026-08-02T08:10:00.000Z",
  updatedAt: "2026-08-02T09:10:00.000Z",
}

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={["/community/exchange/offices/shanghai-weekend"]}
    >
      <Routes>
        <Route
          path="/community/exchange/offices/:officeSlug"
          element={<CommunityOfficePage />}
        />
      </Routes>
    </MemoryRouter>
  )
}

function mockAuthenticatedPlatformSession() {
  platformMocks.usePlatformSession.mockReturnValue({
    status: "authenticated",
    session: {
      success: true,
      account: { id: "platform-1", status: "active" },
      profile: {
        displayName: "春香P",
        avatarUrl: null,
        homeCity: "上海",
        bio: "",
      },
    },
    error: null,
    acceptSession: vi.fn(),
    reload: vi.fn(),
    logout: vi.fn(),
  })
}

describe("CommunityOfficePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformMocks.usePlatformSession.mockReturnValue({
      status: "anonymous",
      session: null,
      error: null,
      acceptSession: vi.fn(),
      reload: vi.fn(),
      logout: vi.fn(),
    })
    apiMocks.getFudabaOffice.mockReturnValue({ send: apiMocks.sendOffice })
    apiMocks.getFudabaOwnerCards.mockReturnValue({
      send: apiMocks.sendOwnerCards,
    })
    apiMocks.getFudabaSeries.mockReturnValue({ send: apiMocks.sendSeries })
    apiMocks.getPlatformProfile.mockReturnValue({ send: apiMocks.sendProfile })
    apiMocks.saveFudabaCardPlacement.mockReturnValue({
      send: apiMocks.sendPlacement,
    })
    apiMocks.sendSeries.mockResolvedValue({
      items: [
        {
          id: 1,
          code: "765",
          displayName: "765PRO",
          color: "#f34f6d",
          iconUrl: "/icon/agencies/1.webp",
          imageTransform: {
            fit: "contain",
            focalX: 0.5,
            focalY: 0.5,
            zoom: 1,
            rotation: 0,
          },
          displayOrder: 0,
          activeOfficeCount: 1,
        },
      ],
    })
    apiMocks.sendOffice.mockResolvedValue({
      id: "office-1",
      slug: "shanghai-weekend",
      name: "上海周末交换事务所",
      intro: "每周末开放的线下交换点。",
      city: "上海",
      accent: "#2581c7",
      coverUrl: null,
      isOpen: true,
      visitorCount: 21,
      seriesCodes: ["765"],
      cards: [placedCard],
    })
    apiMocks.sendOwnerCards.mockResolvedValue({ items: [ownerCard] })
    apiMocks.sendProfile.mockResolvedValue({
      success: true,
      account: { id: "platform-1", status: "active" },
      capabilities: { fudabaWrite: true },
      profile: {
        displayName: "春香P",
        avatarUrl: null,
        homeCity: "上海",
        bio: "",
        updatedAt: 1,
      },
    })
    apiMocks.sendPlacement.mockResolvedValue({
      success: true,
      placement: {
        ...placedCard.placement,
        x: 46,
        revision: 4,
        updatedAt: "2026-08-02T10:00:00.000Z",
      },
    })
  })

  it("renders placement view and an accessible card list", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(
      await screen.findByRole("heading", { name: "上海周末交换事务所" })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "查看交换会用名片正面" })
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "列表" }))

    expect(
      screen.getByRole("button", { name: "查看交换会用名片正面" })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "查看交换会用名片背面" })
    ).toBeVisible()
  })

  it("keeps the office usable when the series catalog is unavailable", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Service Unavailable", {
        kind: "http",
        status: 503,
        payload: { error: "Service Unavailable" },
      })
    )

    renderPage()

    expect(
      await screen.findByRole("heading", { name: "上海周末交换事务所" })
    ).toBeVisible()
    expect(screen.getByText("765")).toBeVisible()
    expect(screen.queryByText("事务所暂时无法加载")).not.toBeInTheDocument()
  })

  it("distinguishes a missing office from the disabled feature", async () => {
    apiMocks.sendOffice.mockRejectedValue(
      new ApiError("Fudaba office not found", {
        kind: "http",
        status: 404,
        payload: { error: "Fudaba office not found" },
      })
    )

    renderPage()

    expect(await screen.findByText("未找到这个事务所")).toBeVisible()
    expect(screen.queryByText("社区交换区尚未开放")).not.toBeInTheDocument()
  })

  it("shows the closed state when the feature route is disabled", async () => {
    apiMocks.sendOffice.mockRejectedValue(
      new ApiError("Not Found", {
        kind: "http",
        status: 404,
        payload: "Not Found",
      })
    )

    renderPage()

    expect(await screen.findByText("社区交换区尚未开放")).toBeVisible()
    expect(screen.queryByText("未找到这个事务所")).not.toBeInTheDocument()
  })

  it("saves keyboard placement changes for the signed-in card owner", async () => {
    const user = userEvent.setup()
    mockAuthenticatedPlatformSession()

    renderPage()
    await user.click(await screen.findByRole("button", { name: "布置名片墙" }))
    const handle = await screen.findByRole("button", {
      name: "移动交换会用名片",
    })
    handle.focus()
    await user.keyboard("{ArrowRight}")

    await waitFor(() => {
      expect(apiMocks.saveFudabaCardPlacement).toHaveBeenCalledWith(
        "office-1",
        "card-1",
        {
          x: 46,
          y: 52,
          rotation: -3,
          zIndex: 2,
          expectedRevision: 3,
        }
      )
    })
  })

  it("keeps a successful placement out of the retry path when refresh fails", async () => {
    const user = userEvent.setup()
    mockAuthenticatedPlatformSession()
    apiMocks.sendOwnerCards.mockResolvedValue({
      items: [ownerCard, unplacedOwnerCard],
    })
    apiMocks.sendPlacement.mockResolvedValueOnce({
      success: true,
      placement: {
        pinnedAt: "2026-08-02T10:00:00.000Z",
        x: 50,
        y: 50,
        rotation: 0,
        zIndex: 3,
        revision: 0,
        updatedAt: "2026-08-02T10:00:00.000Z",
      },
    })

    renderPage()
    const editButton = await screen.findByRole("button", {
      name: "布置名片墙",
    })
    apiMocks.sendOffice.mockRejectedValueOnce(
      new ApiError("Service Unavailable", {
        kind: "http",
        status: 503,
        payload: { error: "Service Unavailable" },
      })
    )

    await user.click(editButton)
    const addButton = screen.getByRole("button", { name: "放到墙上" })
    await user.click(addButton)

    await waitFor(() => {
      expect(apiMocks.sendOffice).toHaveBeenCalledTimes(2)
      expect(addButton).toBeDisabled()
    })
    expect(apiMocks.saveFudabaCardPlacement).toHaveBeenCalledOnce()
    expect(apiMocks.saveFudabaCardPlacement).toHaveBeenCalledWith(
      "office-1",
      "card-2",
      {
        x: 50,
        y: 50,
        rotation: 0,
        zIndex: 3,
        expectedRevision: null,
      }
    )
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "名片已放到墙上，但最新墙面暂时无法重新载入。"
    )
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(toastMocks.error).not.toHaveBeenCalled()

    await user.click(addButton)
    expect(apiMocks.saveFudabaCardPlacement).toHaveBeenCalledOnce()
  })

  it("asks for a manual reload when conflict recovery cannot refresh", async () => {
    const user = userEvent.setup()
    mockAuthenticatedPlatformSession()

    renderPage()
    const editButton = await screen.findByRole("button", {
      name: "布置名片墙",
    })
    apiMocks.sendPlacement.mockRejectedValueOnce(
      new ApiError("Placement conflict", {
        kind: "http",
        status: 409,
        code: "FUDABA_CARD_PLACEMENT_CONFLICT",
        payload: { revision: 4 },
      })
    )
    apiMocks.sendOffice.mockRejectedValueOnce(
      new ApiError("Service Unavailable", {
        kind: "http",
        status: 503,
        payload: { error: "Service Unavailable" },
      })
    )

    await user.click(editButton)
    const handle = screen.getByRole("button", {
      name: "移动交换会用名片",
    })
    handle.focus()
    await user.keyboard("{ArrowRight}")

    await waitFor(() => {
      expect(apiMocks.sendOffice).toHaveBeenCalledTimes(2)
      expect(toastMocks.error).toHaveBeenCalledWith(
        "名片墙已在其他页面更新，但最新布局暂时无法载入，请重新加载页面。"
      )
    })
    expect(toastMocks.error).not.toHaveBeenCalledWith(
      "名片墙已在其他页面更新，当前布局已重新载入。"
    )
  })
})
