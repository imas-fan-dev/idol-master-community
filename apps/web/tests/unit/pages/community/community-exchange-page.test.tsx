import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "~/lib/api"
import CommunityExchangePage from "~/pages/community/exchange/community-exchange-page"

const apiMocks = vi.hoisted(() => ({
  getFudabaSeries: vi.fn(),
  getFudabaOfficePage: vi.fn(),
  getFudabaCardPage: vi.fn(),
  sendSeries: vi.fn(),
  sendOffices: vi.fn(),
  sendCards: vi.fn(),
}))

const mapSectionMock = vi.hoisted(() => ({ renders: vi.fn() }))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    getFudabaSeries: apiMocks.getFudabaSeries,
    getFudabaOfficePage: apiMocks.getFudabaOfficePage,
    getFudabaCardPage: apiMocks.getFudabaCardPage,
  }
})

vi.mock("~/pages/community/exchange/community-exchange-map-section", () => ({
  CommunityExchangeMapSection: (props: {
    city?: string
    series?: string
    open?: boolean
    onSwitchDirectory: () => void
  }) => {
    mapSectionMock.renders(props)
    return (
      <button type="button" onClick={props.onSwitchDirectory}>
        模拟地图内容
      </button>
    )
  },
}))

const office = {
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
}

const card = {
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
    viewerLiked: false,
    viewerFavorited: false,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="current search">{location.search}</output>
}

describe("CommunityExchangePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getFudabaSeries.mockReturnValue({ send: apiMocks.sendSeries })
    apiMocks.getFudabaOfficePage.mockReturnValue({ send: apiMocks.sendOffices })
    apiMocks.getFudabaCardPage.mockReturnValue({ send: apiMocks.sendCards })
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
        {
          id: 3,
          code: "cg",
          displayName: "灰姑娘女孩",
          color: "#2681c8",
          iconUrl: null,
          imageTransform: {
            fit: "contain",
            focalX: 0.5,
            focalY: 0.5,
            zoom: 1,
            rotation: 0,
          },
          displayOrder: 2,
          activeOfficeCount: 0,
        },
      ],
    })
    apiMocks.sendOffices.mockResolvedValue({
      items: [office],
      pageInfo: { hasNextPage: false, nextCursor: null },
    })
    apiMocks.sendCards.mockResolvedValue({
      items: [card],
      pageInfo: { hasNextPage: false, nextCursor: null },
    })
  })

  it("opens on the map and keeps both public directories reachable", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/community/exchange"]}>
        <CommunityExchangePage />
      </MemoryRouter>
    )

    const map = await screen.findByRole("button", { name: "模拟地图内容" })
    expect(map).toBeVisible()
    expect(apiMocks.getFudabaOfficePage).toHaveBeenCalledWith({
      city: undefined,
      series: undefined,
      open: undefined,
      limit: 12,
    })
    expect(mapSectionMock.renders).toHaveBeenCalledWith(
      expect.objectContaining({
        city: undefined,
        series: undefined,
        open: undefined,
      })
    )
    expect(
      screen.getByRole("complementary", { name: "交换发现栏" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "名片交换信号地图" })
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "全部企划" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    const agencyButton = screen.getByRole("button", { name: /765PRO/ })
    expect(agencyButton.querySelector("img")).toHaveAttribute(
      "src",
      "/icon/agencies/1.webp"
    )
    const agencyWithoutIcon = screen.getByRole("button", {
      name: /灰姑娘女孩/,
    })
    expect(agencyWithoutIcon.querySelector("img")).toBeNull()
    expect(agencyWithoutIcon.querySelector("[aria-hidden='true']")).toHaveStyle(
      {
        backgroundColor: "#2681c8",
      }
    )

    await user.click(map)
    expect((await screen.findAllByText("上海周末交换事务所"))[0]).toBeVisible()
    expect(screen.getByLabelText("21 次访问")).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "名片" }))
    expect(await screen.findByText("交换会用名片")).toBeVisible()
    expect(screen.getByLabelText("2 次点赞")).toBeVisible()
    expect(screen.getByLabelText("1 次收藏")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "关闭" }))
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "公开交换名录" })
      ).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole("checkbox", { name: "仅看开放事务所" }))

    await waitFor(() => {
      expect(apiMocks.getFudabaOfficePage).toHaveBeenLastCalledWith({
        city: undefined,
        series: undefined,
        open: true,
        limit: 12,
      })
    })
  })

  it("uses the canonical agency code for every discovery request", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/community/exchange"]}>
        <CommunityExchangePage />
        <LocationProbe />
      </MemoryRouter>
    )

    await user.click(await screen.findByRole("button", { name: /765PRO/ }))

    await waitFor(() => {
      const search = new URLSearchParams(
        screen.getByLabelText("current search").textContent ?? ""
      )
      expect(search.get("series")).toBe("765")
      expect(apiMocks.getFudabaOfficePage).toHaveBeenLastCalledWith({
        city: undefined,
        series: "765",
        open: undefined,
        limit: 12,
      })
      expect(apiMocks.getFudabaCardPage).toHaveBeenLastCalledWith({
        series: "765",
        available: true,
        limit: 8,
      })
      expect(mapSectionMock.renders).toHaveBeenLastCalledWith(
        expect.objectContaining({ series: "765" })
      )
    })
  })

  it("keeps only filters in the URL and opens the directory escape hatch", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter
        initialEntries={[
          "/community/exchange?view=map&city=%E4%B8%8A%E6%B5%B7&bbox=100,20,130,45",
        ]}
      >
        <CommunityExchangePage />
        <LocationProbe />
      </MemoryRouter>
    )

    expect(
      await screen.findByRole("button", { name: "模拟地图内容" })
    ).toBeVisible()
    await waitFor(() => {
      const search = new URLSearchParams(
        screen.getByLabelText("current search").textContent ?? ""
      )
      expect(search.has("view")).toBe(false)
      expect(search.get("city")).toBe("上海")
      expect(search.has("bbox")).toBe(false)
    })
    expect(mapSectionMock.renders).toHaveBeenLastCalledWith(
      expect.objectContaining({ city: "上海" })
    )

    await user.click(screen.getByRole("button", { name: "清除筛选" }))
    await waitFor(() => {
      const search = new URLSearchParams(
        screen.getByLabelText("current search").textContent ?? ""
      )
      expect([...search.entries()]).toEqual([])
    })

    await user.click(screen.getByRole("button", { name: "模拟地图内容" }))
    expect((await screen.findAllByText("上海周末交换事务所"))[0]).toBeVisible()
    expect(screen.getByRole("heading", { name: "公开交换名录" })).toBeVisible()
  })

  it("shows the neutral closed state for the server feature flag", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Not Found", {
        kind: "http",
        status: 404,
        payload: "Not Found",
      })
    )

    render(
      <MemoryRouter>
        <CommunityExchangePage />
      </MemoryRouter>
    )

    expect(await screen.findByText("社区交换区尚未开放")).toBeVisible()
    expect(
      screen.getByRole("link", { name: "返回制作人社区" })
    ).toHaveAttribute("href", "/community")
  })

  it("surfaces an unrelated JSON 404 as an error", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Fudaba series not found", {
        kind: "http",
        status: 404,
        payload: { error: "Fudaba series not found" },
      })
    )

    render(
      <MemoryRouter>
        <CommunityExchangePage />
      </MemoryRouter>
    )

    expect(await screen.findByText("社区交换区暂时无法加载")).toBeVisible()
    expect(screen.queryByText("社区交换区尚未开放")).not.toBeInTheDocument()
  })

  it("discards a load-more response after filters change", async () => {
    const stalePage = deferred<{
      items: (typeof office)[]
      pageInfo: { hasNextPage: boolean; nextCursor: string | null }
    }>()
    const currentPage = deferred<{
      items: (typeof office)[]
      pageInfo: { hasNextPage: boolean; nextCursor: string | null }
    }>()
    const filteredOffice = {
      ...office,
      id: "office-2",
      slug: "open-shanghai",
      name: "筛选后的开放事务所",
    }
    const filteredPageOffice = {
      ...office,
      id: "office-3",
      slug: "filtered-next-page",
      name: "当前筛选的下一页事务所",
    }
    apiMocks.sendOffices
      .mockResolvedValueOnce({
        items: [office],
        pageInfo: { hasNextPage: true, nextCursor: "office-cursor" },
      })
      .mockImplementationOnce(() => stalePage.promise)
      .mockResolvedValueOnce({
        items: [filteredOffice],
        pageInfo: { hasNextPage: true, nextCursor: "filtered-cursor" },
      })
      .mockImplementationOnce(() => currentPage.promise)

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/community/exchange"]}>
        <CommunityExchangePage />
      </MemoryRouter>
    )

    await user.click(
      await screen.findByRole("button", { name: "模拟地图内容" })
    )
    await user.click(screen.getByRole("button", { name: "加载更多事务所" }))
    await user.click(screen.getByRole("button", { name: "关闭" }))
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "公开交换名录" })
      ).not.toBeInTheDocument()
    })
    await user.click(screen.getByRole("checkbox", { name: "仅看开放事务所" }))

    await waitFor(() => {
      expect(apiMocks.getFudabaOfficePage).toHaveBeenLastCalledWith({
        city: undefined,
        series: undefined,
        open: true,
        limit: 12,
      })
    })
    await user.click(screen.getByRole("button", { name: "模拟地图内容" }))
    expect((await screen.findAllByText("筛选后的开放事务所"))[0]).toBeVisible()
    await user.click(screen.getByRole("button", { name: "加载更多事务所" }))

    expect(apiMocks.getFudabaOfficePage).toHaveBeenLastCalledWith({
      city: undefined,
      series: undefined,
      open: true,
      cursor: "filtered-cursor",
      limit: 12,
    })
    const requestCount = apiMocks.getFudabaOfficePage.mock.calls.length
    expect(screen.getByRole("button", { name: "正在加载" })).toBeDisabled()

    await act(async () => {
      stalePage.resolve({
        items: [
          {
            ...office,
            id: "office-stale",
            slug: "stale-office",
            name: "过期分页结果",
          },
        ],
        pageInfo: { hasNextPage: false, nextCursor: null },
      })
      await stalePage.promise
    })

    expect(screen.getByRole("button", { name: "正在加载" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "正在加载" }))
    expect(apiMocks.getFudabaOfficePage).toHaveBeenCalledTimes(requestCount)
    expect(screen.queryByText("过期分页结果")).not.toBeInTheDocument()

    await act(async () => {
      currentPage.resolve({
        items: [filteredPageOffice],
        pageInfo: { hasNextPage: false, nextCursor: null },
      })
      await currentPage.promise
    })

    expect(screen.getAllByText("当前筛选的下一页事务所")[0]).toBeVisible()
  })
})
