import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CommunityExchangeMapSection } from "~/pages/community/exchange/community-exchange-map-section"

const apiMocks = vi.hoisted(() => ({
  getFudabaMapConfig: vi.fn(),
  getFudabaMapOffices: vi.fn(),
  sendConfig: vi.fn(),
  sendOffices: vi.fn(),
}))

const mapModule = vi.hoisted(() => ({ renders: vi.fn() }))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    getFudabaMapConfig: apiMocks.getFudabaMapConfig,
    getFudabaMapOffices: apiMocks.getFudabaMapOffices,
  }
})

vi.mock("~/pages/community/exchange/exchange-office-map", () => {
  return {
    ExchangeOfficeMap: (
      props: import("~/pages/community/exchange/exchange-office-map").ExchangeOfficeMapProps
    ) => {
      mapModule.renders(props.styleUrl)
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              props.onViewportChange([[100, 20, 130, 45]] as const)
            }
          >
            模拟地图移动
          </button>
          {props.groups.map((group) => (
            <button
              key={group.key}
              type="button"
              aria-label={`${group.offices
                .map((office) => office.name)
                .join("、")}，${group.offices.length} 个事务所`}
              onClick={() => props.onSelectGroup(group.key)}
            >
              模拟区域点
            </button>
          ))}
        </div>
      )
    },
  }
})

const office = {
  id: "office-1",
  slug: "shanghai-weekend",
  name: "上海周末交换事务所",
  city: "上海",
  accent: "#f34e6c",
  isOpen: true,
  seriesCodes: ["765"],
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional" as const,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderSection(
  props: Partial<React.ComponentProps<typeof CommunityExchangeMapSection>> = {}
) {
  return render(
    <MemoryRouter>
      <CommunityExchangeMapSection onSwitchDirectory={vi.fn()} {...props} />
    </MemoryRouter>
  )
}

describe("CommunityExchangeMapSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 1023px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )
    apiMocks.getFudabaMapConfig.mockReturnValue({ send: apiMocks.sendConfig })
    apiMocks.getFudabaMapOffices.mockReturnValue({
      send: apiMocks.sendOffices,
    })
    apiMocks.sendConfig.mockResolvedValue({
      styleUrl: "/api/community/exchange/map/style.json",
    })
    apiMocks.sendOffices.mockResolvedValue({ items: [], truncated: false })
  })

  it("loads the map only after strict config and groups regional offices", async () => {
    const user = userEvent.setup()
    apiMocks.sendOffices.mockResolvedValue({
      items: [
        office,
        {
          ...office,
          id: "office-2",
          slug: "same-region",
          name: "同区域交换事务所",
          seriesCodes: ["cg"],
          accent: "#2581c7",
        },
      ],
      truncated: true,
    })

    renderSection({ city: "上海", open: true })

    const map = await screen.findByRole("button", { name: "模拟地图移动" })
    expect(mapModule.renders).toHaveBeenCalledWith(
      "/api/community/exchange/map/style.json"
    )
    await user.click(map)

    await waitFor(() => {
      expect(apiMocks.getFudabaMapOffices).toHaveBeenCalledWith({
        bbox: [100, 20, 130, 45],
        city: "上海",
        series: undefined,
        open: true,
        limit: 200,
      })
    })
    const regions = await screen.findAllByRole("button", {
      name: /上海周末交换事务所、同区域交换事务所，2 个事务所/,
    })
    await user.click(regions[0]!)
    expect(screen.getAllByText("上海周末交换事务所")[0]).toBeVisible()
    expect(screen.getAllByText("同区域交换事务所")[0]).toBeVisible()
    expect(screen.getByText(/当前范围结果较多/)).toBeVisible()
  })

  it("discards a stale viewport response after filters change", async () => {
    const user = userEvent.setup()
    const stale = deferred<{ items: (typeof office)[]; truncated: boolean }>()
    const current = deferred<{ items: (typeof office)[]; truncated: boolean }>()
    apiMocks.sendOffices
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)

    const view = renderSection()
    await user.click(
      await screen.findByRole("button", { name: "模拟地图移动" })
    )
    view.rerender(
      <MemoryRouter>
        <CommunityExchangeMapSection city="上海" onSwitchDirectory={vi.fn()} />
      </MemoryRouter>
    )

    await act(async () => {
      current.resolve({
        items: [{ ...office, name: "当前筛选事务所" }],
        truncated: false,
      })
      await current.promise
    })
    expect(
      (
        await screen.findAllByRole("button", {
          name: /当前筛选事务所，1 个事务所/,
        })
      )[0]
    ).toBeVisible()

    await act(async () => {
      stale.resolve({
        items: [{ ...office, id: "stale", name: "过期地图事务所" }],
        truncated: false,
      })
      await stale.promise
    })
    expect(screen.queryByText("过期地图事务所")).not.toBeInTheDocument()
  })

  it("retains the previous successful map result when refresh fails", async () => {
    const user = userEvent.setup()
    apiMocks.sendOffices.mockResolvedValueOnce({
      items: [office],
      truncated: false,
    })
    const view = renderSection()
    await user.click(
      await screen.findByRole("button", { name: "模拟地图移动" })
    )
    expect(
      (
        await screen.findAllByRole("button", {
          name: /上海周末交换事务所，1 个事务所/,
        })
      )[0]
    ).toBeVisible()

    apiMocks.sendOffices.mockRejectedValueOnce(new Error("regional API down"))
    view.rerender(
      <MemoryRouter>
        <CommunityExchangeMapSection city="北京" onSwitchDirectory={vi.fn()} />
      </MemoryRouter>
    )

    expect(await screen.findByText("地图数据更新失败")).toBeVisible()
    expect(
      screen.getAllByRole("button", {
        name: /上海周末交换事务所，1 个事务所/,
      })[0]
    ).toBeVisible()
  })

  it("keeps a directory escape hatch when map config fails", async () => {
    const switchDirectory = vi.fn()
    apiMocks.sendConfig.mockRejectedValue(new Error("map disabled"))
    const user = userEvent.setup()
    renderSection({ onSwitchDirectory: switchDirectory })

    expect(await screen.findByText("地图暂时不可用")).toBeVisible()
    expect(screen.getByText("map disabled")).toBeVisible()
    expect(mapModule.renders).not.toHaveBeenCalled()
    expect(apiMocks.getFudabaMapOffices).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "查看事务所名录" }))
    expect(switchDirectory).toHaveBeenCalledOnce()
  })
})
