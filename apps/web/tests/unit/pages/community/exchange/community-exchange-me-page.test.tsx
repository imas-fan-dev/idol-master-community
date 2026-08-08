import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "~/lib/api"
import CommunityExchangeMePage from "~/pages/community/exchange/me/community-exchange-me-page"

const sessionMocks = vi.hoisted(() => ({
  usePlatformSession: vi.fn(),
  reload: vi.fn(),
}))

const apiMocks = vi.hoisted(() => ({
  getPlatformProfile: vi.fn(),
  getFudabaOwnerSeries: vi.fn(),
  getFudabaOwnerCards: vi.fn(),
  getFudabaOwnerCard: vi.fn(),
  updatePlatformProfile: vi.fn(),
  uploadPlatformAvatar: vi.fn(),
  createFudabaCard: vi.fn(),
  updateFudabaCard: vi.fn(),
  uploadFudabaCardMedia: vi.fn(),
  deleteFudabaCard: vi.fn(),
  sendProfile: vi.fn(),
  sendSeries: vi.fn(),
  sendCards: vi.fn(),
  sendCard: vi.fn(),
  sendProfileUpdate: vi.fn(),
  sendAvatarUpload: vi.fn(),
  sendCreate: vi.fn(),
  sendUpdate: vi.fn(),
  sendMediaUpload: vi.fn(),
  sendDelete: vi.fn(),
}))

vi.mock("~/components/platform/platform-session-provider", () => ({
  usePlatformSession: sessionMocks.usePlatformSession,
}))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    hasPlatformSessionHint: () => false,
    getPlatformProfile: apiMocks.getPlatformProfile,
    getFudabaOwnerSeries: apiMocks.getFudabaOwnerSeries,
    getFudabaOwnerCards: apiMocks.getFudabaOwnerCards,
    getFudabaOwnerCard: apiMocks.getFudabaOwnerCard,
    updatePlatformProfile: apiMocks.updatePlatformProfile,
    uploadPlatformAvatar: apiMocks.uploadPlatformAvatar,
    createFudabaCard: apiMocks.createFudabaCard,
    updateFudabaCard: apiMocks.updateFudabaCard,
    uploadFudabaCardMedia: apiMocks.uploadFudabaCardMedia,
    deleteFudabaCard: apiMocks.deleteFudabaCard,
  }
})

const profile = {
  displayName: "春香P",
  avatarUrl: null,
  homeCity: "上海",
  bio: "周末交换",
  updatedAt: 10,
}

const series = {
  id: 1,
  code: "765",
  displayName: "765PRO",
  color: "#f34f6d",
  iconUrl: "/icon/agencies/1.webp",
  imageTransform: {
    fit: "contain" as const,
    focalX: 0.5,
    focalY: 0.5,
    zoom: 1,
    rotation: 0 as const,
  },
  displayOrder: 0,
  activeOfficeCount: 1,
}

const card = {
  id: "card-1",
  producerName: "春香P",
  displayName: "周末交换名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/api/community/exchange/me/cards/card-1/media/front?v=3",
  backImageUrl: "/api/community/exchange/me/cards/card-1/media/back?v=3",
  accent: "#f34e6c",
  bio: "上海地区制作人",
  tradeNote: "周末现场交换",
  available: true,
  mediaRightsStatus: "approved" as const,
  publicationStatus: "draft" as const,
  revision: 3,
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
}

function authenticatedSession(
  status: "authenticated" | "restricted" = "authenticated"
) {
  return {
    status,
    session: {
      success: true,
      account: {
        id: "platform-1",
        status: status === "restricted" ? "restricted" : "active",
      },
      profile: {
        displayName: profile.displayName,
        avatarUrl: null,
        homeCity: profile.homeCity,
        bio: profile.bio,
      },
    },
    error: null,
    reload: sessionMocks.reload,
    logout: vi.fn(),
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/community/exchange/me"]}>
      <CommunityExchangeMePage />
    </MemoryRouter>
  )
}

describe("CommunityExchangeMePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionMocks.usePlatformSession.mockReturnValue(authenticatedSession())
    apiMocks.getPlatformProfile.mockReturnValue({ send: apiMocks.sendProfile })
    apiMocks.getFudabaOwnerSeries.mockReturnValue({ send: apiMocks.sendSeries })
    apiMocks.getFudabaOwnerCards.mockReturnValue({ send: apiMocks.sendCards })
    apiMocks.getFudabaOwnerCard.mockReturnValue({ send: apiMocks.sendCard })
    apiMocks.updatePlatformProfile.mockReturnValue({
      send: apiMocks.sendProfileUpdate,
    })
    apiMocks.uploadPlatformAvatar.mockReturnValue({
      send: apiMocks.sendAvatarUpload,
    })
    apiMocks.createFudabaCard.mockReturnValue({ send: apiMocks.sendCreate })
    apiMocks.updateFudabaCard.mockReturnValue({ send: apiMocks.sendUpdate })
    apiMocks.uploadFudabaCardMedia.mockReturnValue({
      send: apiMocks.sendMediaUpload,
    })
    apiMocks.deleteFudabaCard.mockReturnValue({ send: apiMocks.sendDelete })

    apiMocks.sendProfile.mockResolvedValue({
      success: true,
      account: { id: "platform-1", status: "active" },
      capabilities: { fudabaWrite: true },
      profile,
    })
    apiMocks.sendSeries.mockResolvedValue({ items: [series] })
    apiMocks.sendCards.mockResolvedValue({ items: [card] })
    apiMocks.sendCard.mockResolvedValue({ card })
    apiMocks.sendProfileUpdate.mockResolvedValue({
      success: true,
      profile: { ...profile, displayName: "更新后的制作人", updatedAt: 11 },
    })
    apiMocks.sendAvatarUpload.mockResolvedValue({
      success: true,
      profile: {
        ...profile,
        avatarUrl: "/api/platform/me/avatar?v=11",
        updatedAt: 11,
      },
    })
    apiMocks.sendUpdate.mockResolvedValue({
      success: true,
      card: { ...card, displayName: "更新后的名片", revision: 4 },
    })
    apiMocks.sendMediaUpload.mockResolvedValue({
      success: true,
      card: { ...card, revision: 4 },
    })
    apiMocks.sendCreate.mockResolvedValue({
      success: true,
      card: { ...card, id: "card-new", revision: 0 },
    })
    apiMocks.sendDelete.mockResolvedValue({ success: true, revision: 4 })
  })

  it("saves profile and card metadata with their current versions", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(
      await screen.findByRole("heading", { name: "我的交换名片" })
    ).toBeVisible()
    expect(screen.getByText("素材已核准")).toBeVisible()
    expect(screen.getAllByText("草稿")).toHaveLength(2)

    const profileName = screen.getByRole("textbox", { name: "显示名称" })
    await user.clear(profileName)
    await user.type(profileName, "更新后的制作人")
    await user.click(screen.getByRole("button", { name: "保存资料" }))

    await waitFor(() => {
      expect(apiMocks.updatePlatformProfile).toHaveBeenCalledWith({
        displayName: "更新后的制作人",
        homeCity: "上海",
        bio: "周末交换",
        expectedUpdatedAt: 10,
      })
    })
    expect(await screen.findByText("制作人资料已保存。")).toBeVisible()

    const cardName = screen.getByRole("textbox", { name: "名片标题" })
    await user.clear(cardName)
    await user.type(cardName, "更新后的名片")
    await user.click(screen.getByRole("button", { name: "保存名片资料" }))

    await waitFor(() => {
      expect(apiMocks.updateFudabaCard).toHaveBeenCalledWith(
        "card-1",
        expect.objectContaining({
          displayName: "更新后的名片",
          expectedRevision: 3,
        })
      )
    })
    expect(await screen.findByText("名片资料已保存。")).toBeVisible()
  })

  it("preserves card input and offers reload after a revision conflict", async () => {
    apiMocks.sendUpdate.mockRejectedValue(
      new ApiError("名片版本冲突", {
        kind: "http",
        status: 409,
        code: "FUDABA_CARD_CONFLICT",
        payload: { revision: 4 },
      })
    )
    const user = userEvent.setup()
    renderPage()

    const cardName = await screen.findByRole("textbox", { name: "名片标题" })
    await user.clear(cardName)
    await user.type(cardName, "仍需保留的输入")
    await user.click(screen.getByRole("button", { name: "保存名片资料" }))

    expect(await screen.findByText("名片版本冲突")).toBeVisible()
    expect(cardName).toHaveValue("仍需保留的输入")
    expect(screen.getByRole("button", { name: "载入最新名片" })).toBeVisible()
  })

  it("creates a card from the empty state and deletes it through confirmation", async () => {
    apiMocks.sendCards.mockResolvedValue({ items: [] })
    const createdCard = { ...card, id: "card-new", revision: 0 }
    apiMocks.sendCreate.mockResolvedValue({ success: true, card: createdCard })
    const user = userEvent.setup()
    renderPage()

    const cardName = await screen.findByRole("textbox", { name: "名片标题" })
    await user.type(cardName, "新交换名片")
    await user.upload(
      screen.getByLabelText("名片正面"),
      new File(["front"], "front.png", { type: "image/png" })
    )
    await user.upload(
      screen.getByLabelText("名片背面"),
      new File(["back"], "back.png", { type: "image/png" })
    )
    await user.click(screen.getByRole("button", { name: "创建名片草稿" }))

    await waitFor(() => {
      expect(apiMocks.createFudabaCard).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "新交换名片",
          seriesCode: "765",
          front: expect.any(File),
          back: expect.any(File),
        })
      )
    })
    expect(await screen.findByText("周末交换名片")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "删除名片" }))
    expect(
      screen.getByRole("heading", { name: "删除这张名片？" })
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "确认删除" }))

    await waitFor(() => {
      expect(apiMocks.deleteFudabaCard).toHaveBeenCalledWith("card-new", 0)
    })
    expect(await screen.findByText("还没有交换名片")).toBeVisible()
  })

  it("keeps restricted and rollout-closed workspaces readable but disabled", async () => {
    sessionMocks.usePlatformSession.mockReturnValue(
      authenticatedSession("restricted")
    )
    apiMocks.sendProfile.mockResolvedValue({
      success: true,
      account: { id: "platform-1", status: "restricted" },
      capabilities: { fudabaWrite: false },
      profile,
    })
    renderPage()

    expect(await screen.findByText("帐号受限")).toBeVisible()
    expect(screen.getByRole("textbox", { name: "显示名称" })).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "名片标题" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "新建名片" })).toBeDisabled()
    expect(screen.getByText("周末交换名片")).toBeVisible()
  })

  it("does not probe owner APIs for an anonymous visitor", () => {
    sessionMocks.usePlatformSession.mockReturnValue({
      status: "anonymous",
      session: null,
      error: null,
      reload: sessionMocks.reload,
      logout: vi.fn(),
    })
    renderPage()

    expect(screen.getByText("请先登录平台帐号")).toBeVisible()
    expect(apiMocks.getPlatformProfile).not.toHaveBeenCalled()
    expect(apiMocks.getFudabaOwnerCards).not.toHaveBeenCalled()
  })
})
