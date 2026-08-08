import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError, type FudabaOwnerOffice } from "~/lib/api"
import { OfficeLocationWorkspace } from "~/pages/community/exchange/me/office-location-workspace"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const apiMocks = vi.hoisted(() => ({
  getFudabaOwnerOffices: vi.fn(),
  getFudabaOwnerOffice: vi.fn(),
  getFudabaOwnerLocation: vi.fn(),
  createFudabaOffice: vi.fn(),
  updateFudabaOwnerOffice: vi.fn(),
  saveFudabaOwnerLocation: vi.fn(),
  withdrawFudabaOwnerLocation: vi.fn(),
  sendOffices: vi.fn(),
  sendOffice: vi.fn(),
  sendLocation: vi.fn(),
  sendCreate: vi.fn(),
  sendOfficeUpdate: vi.fn(),
  sendLocationSave: vi.fn(),
  sendLocationWithdrawal: vi.fn(),
}))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    getFudabaOwnerOffices: apiMocks.getFudabaOwnerOffices,
    getFudabaOwnerOffice: apiMocks.getFudabaOwnerOffice,
    getFudabaOwnerLocation: apiMocks.getFudabaOwnerLocation,
    createFudabaOffice: apiMocks.createFudabaOffice,
    updateFudabaOwnerOffice: apiMocks.updateFudabaOwnerOffice,
    saveFudabaOwnerLocation: apiMocks.saveFudabaOwnerLocation,
    withdrawFudabaOwnerLocation: apiMocks.withdrawFudabaOwnerLocation,
  }
})

const series = [
  {
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
  },
]

const office: FudabaOwnerOffice = {
  id: "office-1",
  slug: "shanghai-office-1",
  name: "上海周末事务所",
  intro: "周末线下交换",
  city: "上海",
  address: "西岸艺术中心入口",
  location: { latitude: 31.18452, longitude: 121.45678, precision: "exact" },
  accent: "#2581c7",
  coverUrl: null,
  pendingCoverUrl: null,
  pendingCoverSubmittedAt: null,
  isOpen: true,
  visitorCount: 12,
  status: "active",
  revision: 3,
  seriesCodes: ["765"],
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
  archivedAt: null,
}

const location = {
  officeId: office.id,
  location: { latitude: 31.2, longitude: 121.5, precision: "regional" },
  reviewState: "published",
  revision: 2,
  submittedAt: "2026-08-02T09:00:00.000Z",
  reviewedAt: "2026-08-02T10:00:00.000Z",
  reviewNote: "区域范围合适",
} as const

const secondOffice = {
  ...office,
  id: "office-2",
  slug: "beijing-office-2",
  name: "北京周末事务所",
  city: "北京",
  address: "首钢园入口",
  location: { latitude: 39.9042, longitude: 116.4074, precision: "exact" },
  revision: 7,
} as const

const secondLocation = {
  ...location,
  officeId: secondOffice.id,
  location: { latitude: 39.9, longitude: 116.4, precision: "regional" },
  revision: 5,
  reviewNote: "北京区域已核准",
} as const

function renderWorkspace() {
  return render(
    <OfficeLocationWorkspace
      series={series}
      homeCity="上海"
      readOnly={false}
      onWriteClosed={vi.fn()}
    />
  )
}

function mockTwoOffices() {
  apiMocks.sendOffices.mockResolvedValue({ items: [office, secondOffice] })
  apiMocks.getFudabaOwnerOffice.mockImplementation((officeId: string) => ({
    send: vi.fn().mockResolvedValue({
      office: officeId === secondOffice.id ? secondOffice : office,
    }),
  }))
  apiMocks.getFudabaOwnerLocation.mockImplementation((officeId: string) => ({
    send: vi.fn().mockResolvedValue({
      location: officeId === secondOffice.id ? secondLocation : location,
    }),
  }))
}

describe("OfficeLocationWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getFudabaOwnerOffices.mockReturnValue({
      send: apiMocks.sendOffices,
    })
    apiMocks.getFudabaOwnerOffice.mockReturnValue({ send: apiMocks.sendOffice })
    apiMocks.getFudabaOwnerLocation.mockReturnValue({
      send: apiMocks.sendLocation,
    })
    apiMocks.createFudabaOffice.mockReturnValue({ send: apiMocks.sendCreate })
    apiMocks.updateFudabaOwnerOffice.mockReturnValue({
      send: apiMocks.sendOfficeUpdate,
    })
    apiMocks.saveFudabaOwnerLocation.mockReturnValue({
      send: apiMocks.sendLocationSave,
    })
    apiMocks.withdrawFudabaOwnerLocation.mockReturnValue({
      send: apiMocks.sendLocationWithdrawal,
    })
    apiMocks.sendOffices.mockResolvedValue({ items: [office] })
    apiMocks.sendOffice.mockResolvedValue({ office })
    apiMocks.sendLocation.mockResolvedValue({ location })
    apiMocks.sendCreate.mockResolvedValue({ success: true, office })
    apiMocks.sendOfficeUpdate.mockResolvedValue({ success: true, office })
    apiMocks.sendLocationSave.mockResolvedValue({
      success: true,
      officeLocation: { ...location, reviewState: "pending", revision: 3 },
    })
    apiMocks.sendLocationWithdrawal.mockResolvedValue({ success: true })
  })

  it("keeps exact office coordinates separate from the explicit regional location", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    expect(
      await screen.findByRole("heading", { name: "事务所资料" })
    ).toBeVisible()
    expect(screen.getByRole("spinbutton", { name: "精确纬度" })).toHaveValue(
      31.18452
    )
    expect(screen.getByRole("spinbutton", { name: "区域纬度" })).toHaveValue(
      31.2
    )
    expect(screen.getByText("审核备注")).toBeVisible()
    expect(screen.getByText("区域范围合适")).toBeVisible()

    const regionalLatitude = screen.getByRole("spinbutton", {
      name: "区域纬度",
    })
    await user.clear(regionalLatitude)
    await user.type(regionalLatitude, "31.3")
    await user.click(screen.getByRole("button", { name: "重新提交审核" }))

    await waitFor(() => {
      expect(apiMocks.saveFudabaOwnerLocation).toHaveBeenCalledWith(
        "office-1",
        {
          latitude: 31.3,
          longitude: 121.5,
          expectedRevision: 2,
        }
      )
    })
    expect(await screen.findByText(/区域位置已提交审核/)).toBeVisible()
  })

  it("preserves regional input and offers reload after a CAS conflict", async () => {
    apiMocks.sendLocationSave.mockRejectedValue(
      new ApiError("地图位置版本冲突", {
        kind: "http",
        status: 409,
        code: "FUDABA_OFFICE_LOCATION_CONFLICT",
        payload: { revision: 3 },
      })
    )
    const user = userEvent.setup()
    renderWorkspace()

    const regionalLongitude = await screen.findByRole("spinbutton", {
      name: "区域经度",
    })
    await user.clear(regionalLongitude)
    await user.type(regionalLongitude, "121.6")
    await user.click(screen.getByRole("button", { name: "重新提交审核" }))

    expect(await screen.findByText("地图位置版本冲突")).toBeVisible()
    expect(regionalLongitude).toHaveValue(121.6)
    expect(
      screen.getByRole("button", { name: "载入最新地图位置" })
    ).toBeVisible()
  })

  it("does not apply a delayed office save after another office is selected", async () => {
    mockTwoOffices()
    const pendingSave = deferred<{
      success: true
      office: FudabaOwnerOffice
    }>()
    apiMocks.sendOfficeUpdate.mockReturnValue(pendingSave.promise)
    const user = userEvent.setup()
    renderWorkspace()

    const officeName = await screen.findByRole("textbox", {
      name: "事务所名称",
    })
    await user.clear(officeName)
    await user.type(officeName, "延迟保存的上海事务所")

    await user.click(screen.getByRole("combobox", { name: "当前事务所" }))
    const secondOfficeOption = await screen.findByRole("option", {
      name: secondOffice.name,
    })
    const saveButton = screen.getByRole("button", { name: "保存事务所" })

    act(() => {
      saveButton.click()
      secondOfficeOption.click()
    })

    await waitFor(() => {
      expect(apiMocks.updateFudabaOwnerOffice).toHaveBeenCalledWith(
        office.id,
        expect.objectContaining({
          name: "延迟保存的上海事务所",
          expectedRevision: office.revision,
        })
      )
    })
    expect(
      await screen.findByRole("textbox", { name: "事务所名称" })
    ).toHaveValue(secondOffice.name)

    await act(async () => {
      pendingSave.resolve({
        success: true,
        office: {
          ...office,
          name: "延迟响应中的上海事务所",
          revision: office.revision + 1,
        },
      })
      await pendingSave.promise
    })

    expect(screen.getByRole("textbox", { name: "事务所名称" })).toHaveValue(
      secondOffice.name
    )
    expect(screen.queryByText("事务所资料已保存。")).not.toBeInTheDocument()
  })

  it("locks workspace navigation while an office save is pending", async () => {
    mockTwoOffices()
    const pendingSave = deferred<{
      success: true
      office: FudabaOwnerOffice
    }>()
    apiMocks.sendOfficeUpdate.mockReturnValue(pendingSave.promise)
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(await screen.findByRole("button", { name: "保存事务所" }))
    await waitFor(() => {
      expect(apiMocks.updateFudabaOwnerOffice).toHaveBeenCalledOnce()
    })
    expect(
      screen.getByRole("combobox", { name: "当前事务所", hidden: true })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", {
        name: "刷新我的事务所",
        hidden: true,
      })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "新建事务所", hidden: true })
    ).toBeDisabled()

    await act(async () => {
      pendingSave.resolve({ success: true, office })
      await pendingSave.promise
    })
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "当前事务所" })).toBeEnabled()
    })
  })

  it("creates a complete office with an idempotency key", async () => {
    apiMocks.sendOffices.mockResolvedValue({ items: [] })
    const user = userEvent.setup()
    renderWorkspace()

    expect(
      await screen.findByRole("heading", { name: "创建交换事务所" })
    ).toBeVisible()
    await user.type(
      screen.getByRole("textbox", { name: "事务所名称" }),
      "新事务所"
    )
    await user.type(
      screen.getByRole("textbox", { name: "具体地点" }),
      "场馆入口"
    )
    await user.type(
      screen.getByRole("spinbutton", { name: "精确纬度" }),
      "31.2"
    )
    await user.type(
      screen.getByRole("spinbutton", { name: "精确经度" }),
      "121.5"
    )
    await user.click(screen.getByRole("button", { name: "创建事务所" }))

    await waitFor(() => {
      expect(apiMocks.createFudabaOffice).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "新事务所",
          city: "上海",
          address: "场馆入口",
          latitude: 31.2,
          longitude: 121.5,
          seriesCodes: ["765"],
        }),
        expect.stringMatching(/^fudaba-office-/)
      )
    })
    expect(await screen.findByText("交换事务所已创建。")).toBeVisible()
  })

  it("withdraws a published location and immediately marks it off-map", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await screen.findByRole("heading", { name: "地图公开位置" })
    await user.click(screen.getByRole("button", { name: "撤回公开位置" }))
    await user.click(screen.getByRole("button", { name: "确认撤回" }))

    await waitFor(() => {
      expect(apiMocks.withdrawFudabaOwnerLocation).toHaveBeenCalledWith(
        "office-1",
        2
      )
    })
    expect(
      await screen.findByText("公开位置已撤回，事务所已从区域地图下线。")
    ).toBeVisible()
    expect(screen.getByText("当前位置不在地图上")).toBeVisible()
  })

  it("locks workspace navigation and keeps the target revision during withdrawal", async () => {
    mockTwoOffices()
    const pendingWithdrawal = deferred<{ success: true }>()
    apiMocks.sendLocationWithdrawal.mockReturnValue(pendingWithdrawal.promise)
    const user = userEvent.setup()
    renderWorkspace()

    await screen.findByRole("heading", { name: "地图公开位置" })
    await user.click(screen.getByRole("button", { name: "撤回公开位置" }))
    await user.click(screen.getByRole("button", { name: "确认撤回" }))

    await waitFor(() => {
      expect(apiMocks.withdrawFudabaOwnerLocation).toHaveBeenCalledWith(
        office.id,
        location.revision
      )
    })
    expect(
      screen.getByRole("combobox", { name: "当前事务所", hidden: true })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", {
        name: "刷新我的事务所",
        hidden: true,
      })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "新建事务所", hidden: true })
    ).toBeDisabled()

    await act(async () => {
      pendingWithdrawal.resolve({ success: true })
      await pendingWithdrawal.promise
    })
    expect(
      await screen.findByText("公开位置已撤回，事务所已从区域地图下线。")
    ).toBeVisible()
    expect(screen.getByText("当前位置不在地图上")).toBeVisible()
  })
})
