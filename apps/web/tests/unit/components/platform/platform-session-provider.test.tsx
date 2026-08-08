import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "~/lib/api"
import {
  PlatformSessionProvider,
  usePlatformSession,
} from "~/components/platform/platform-session-provider"

const apiMocks = vi.hoisted(() => ({
  getSessionSend: vi.fn(),
  hasSessionHint: vi.fn(),
  logoutSend: vi.fn(),
}))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    getPlatformSession: () => ({ send: apiMocks.getSessionSend }),
    hasPlatformSessionHint: apiMocks.hasSessionHint,
    logoutPlatform: () => ({ send: apiMocks.logoutSend }),
  }
})

function SessionProbe() {
  const session = usePlatformSession()
  return (
    <div>
      <output aria-label="session-status">{session.status}</output>
      <output aria-label="display-name">
        {session.session?.profile.displayName ?? "none"}
      </output>
      <button type="button" onClick={() => void session.reload()}>
        reload
      </button>
      <button
        type="button"
        onClick={() => session.acceptSession(activeSession)}
      >
        accept
      </button>
      <button type="button" onClick={() => void session.logout()}>
        logout
      </button>
    </div>
  )
}

function renderProvider() {
  return render(
    <PlatformSessionProvider>
      <SessionProbe />
    </PlatformSessionProvider>
  )
}

const activeSession = {
  success: true as const,
  account: { id: "platform-1", status: "active" as const },
  profile: {
    displayName: "Platform Producer",
    avatarUrl: null,
    homeCity: null,
    bio: "",
  },
}

describe("PlatformSessionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stays anonymous and avoids a session request without a cookie hint", () => {
    apiMocks.hasSessionHint.mockReturnValue(false)

    renderProvider()

    expect(screen.getByLabelText("session-status")).toHaveTextContent(
      "anonymous"
    )
    expect(apiMocks.getSessionSend).not.toHaveBeenCalled()
  })

  it("exposes loading before resolving an active session", async () => {
    apiMocks.hasSessionHint.mockReturnValue(true)
    let resolveSession!: (session: typeof activeSession) => void
    apiMocks.getSessionSend.mockReturnValue(
      new Promise<typeof activeSession>((resolve) => {
        resolveSession = resolve
      })
    )

    renderProvider()

    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent(
        "loading"
      )
    )
    await act(() => resolveSession(activeSession))
    expect(screen.getByLabelText("session-status")).toHaveTextContent(
      "authenticated"
    )
    expect(screen.getByLabelText("display-name")).toHaveTextContent(
      "Platform Producer"
    )
  })

  it("keeps restricted accounts authenticated with an explicit state", async () => {
    apiMocks.hasSessionHint.mockReturnValue(true)
    apiMocks.getSessionSend.mockResolvedValue({
      ...activeSession,
      account: { ...activeSession.account, status: "restricted" },
    })

    renderProvider()

    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent(
        "restricted"
      )
    )
  })

  it("accepts a returned login session without requesting it again", async () => {
    apiMocks.hasSessionHint.mockReturnValue(false)

    renderProvider()
    await userEvent.click(screen.getByRole("button", { name: "accept" }))

    expect(screen.getByLabelText("session-status")).toHaveTextContent(
      "authenticated"
    )
    expect(screen.getByLabelText("display-name")).toHaveTextContent(
      "Platform Producer"
    )
    expect(apiMocks.getSessionSend).not.toHaveBeenCalled()
  })

  it("drops rejected sessions but surfaces unexpected failures", async () => {
    apiMocks.hasSessionHint.mockReturnValue(true)
    apiMocks.getSessionSend.mockRejectedValueOnce(
      new ApiError("expired", { kind: "http", status: 401 })
    )

    const view = renderProvider()
    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent(
        "anonymous"
      )
    )

    apiMocks.getSessionSend.mockRejectedValueOnce(
      new ApiError("offline", { kind: "network" })
    )
    await userEvent.click(screen.getByRole("button", { name: "reload" }))
    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent("error")
    )
    view.unmount()
  })

  it("logs out only the Platform session and returns to anonymous", async () => {
    apiMocks.hasSessionHint.mockReturnValue(true)
    apiMocks.getSessionSend.mockResolvedValue(activeSession)
    apiMocks.logoutSend.mockResolvedValue({ success: true })

    renderProvider()
    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent(
        "authenticated"
      )
    )
    await userEvent.click(screen.getByRole("button", { name: "logout" }))

    await waitFor(() =>
      expect(screen.getByLabelText("session-status")).toHaveTextContent(
        "anonymous"
      )
    )
    expect(apiMocks.logoutSend).toHaveBeenCalledOnce()
  })
})
