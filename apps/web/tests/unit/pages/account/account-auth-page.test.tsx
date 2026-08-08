import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nextProvider } from "react-i18next"
import { MemoryRouter, Route, Routes } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { i18n } from "~/i18n/config"
import { ApiError } from "~/lib/api"
import AccountLoginPage from "~/pages/account/login/account-login-page"
import AccountRegisterPage from "~/pages/account/register/account-register-page"

const apiMocks = vi.hoisted(() => ({
  loginInput: vi.fn(),
  loginSend: vi.fn(),
  registerInput: vi.fn(),
  registerSend: vi.fn(),
  verificationInput: vi.fn(),
  verificationSend: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  acceptSession: vi.fn(),
  reload: vi.fn(),
  logout: vi.fn(),
  usePlatformSession: vi.fn(),
}))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    loginPlatform: (input: unknown) => {
      apiMocks.loginInput(input)
      return { send: apiMocks.loginSend }
    },
    registerPlatform: (input: unknown) => {
      apiMocks.registerInput(input)
      return { send: apiMocks.registerSend }
    },
    sendPlatformRegistrationVerificationCode: (input: unknown) => {
      apiMocks.verificationInput(input)
      return { send: apiMocks.verificationSend }
    },
  }
})

vi.mock("~/components/platform/platform-session-provider", () => ({
  usePlatformSession: sessionMocks.usePlatformSession,
}))

const activeSession = {
  success: true as const,
  account: { id: "platform-1", status: "active" as const },
  profile: {
    displayName: "测试制作人",
    avatarUrl: null,
    homeCity: null,
    bio: "",
  },
}

function anonymousState() {
  return {
    status: "anonymous",
    session: null,
    error: null,
    acceptSession: sessionMocks.acceptSession,
    reload: sessionMocks.reload,
    logout: sessionMocks.logout,
  }
}

function renderPage(mode: "login" | "register") {
  const path = `/account/${mode}`
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nextProvider i18n={i18n}>
        <Routes>
          <Route
            path={path}
            element={
              mode === "login" ? <AccountLoginPage /> : <AccountRegisterPage />
            }
          />
          <Route
            path="/community/exchange/me"
            element={<h1>我的交换空间</h1>}
          />
        </Routes>
      </I18nextProvider>
    </MemoryRouter>
  )
}

async function fillLogin() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("邮箱"), "producer@example.com")
  await user.type(
    screen.getByLabelText("密码", { exact: true }),
    "correct-horse-battery"
  )
  return user
}

describe("Platform account auth pages", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    sessionMocks.usePlatformSession.mockReturnValue(anonymousState())
    await i18n.changeLanguage("zh-CN")
  })

  it("validates registration fields before making a request", async () => {
    renderPage("register")
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("显示名称"), "新制作人")
    await user.type(screen.getByLabelText("邮箱"), "not-an-email")
    await user.type(screen.getByLabelText("密码", { exact: true }), "short")
    await user.type(screen.getByLabelText("确认密码"), "different")
    await user.click(screen.getByRole("button", { name: "注册" }))

    expect(screen.getByText("请输入有效的邮箱地址。")).toBeVisible()
    expect(screen.getByText("密码至少需要 8 个字符。")).toBeVisible()
    expect(screen.getByText("两次输入的密码不一致。")).toBeVisible()
    expect(screen.getByText("请输入 6 位数字验证码。")).toBeVisible()
    expect(apiMocks.registerSend).not.toHaveBeenCalled()
  })

  it("rejects passwords over 72 UTF-8 bytes", async () => {
    renderPage("register")
    const user = userEvent.setup()
    const password = "密".repeat(25)
    await user.type(screen.getByLabelText("显示名称"), "新制作人")
    await user.type(screen.getByLabelText("邮箱"), "new@example.com")
    await user.type(screen.getByLabelText("邮箱验证码"), "123456")
    await user.type(screen.getByLabelText("密码", { exact: true }), password)
    await user.type(screen.getByLabelText("确认密码"), password)
    await user.click(screen.getByRole("button", { name: "注册" }))

    expect(
      screen.getByText("密码的 UTF-8 编码不能超过 72 字节。")
    ).toBeVisible()
    expect(apiMocks.registerSend).not.toHaveBeenCalled()
  })

  it("sends a verification code, shows the cooldown, and submits the code", async () => {
    apiMocks.verificationSend.mockResolvedValue({
      success: true,
      retryAfterSeconds: 60,
    })
    apiMocks.registerSend.mockResolvedValue(activeSession)
    renderPage("register")
    const user = userEvent.setup()

    await user.type(screen.getByLabelText("显示名称"), " 新制作人 ")
    await user.type(screen.getByLabelText("邮箱"), " New@Example.COM ")
    await user.click(screen.getByRole("button", { name: "发送验证码" }))

    expect(apiMocks.verificationInput).toHaveBeenCalledWith({
      email: "new@example.com",
    })
    expect(
      await screen.findByText("验证码已发送至 new@example.com。")
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "60 秒后重发" })).toBeDisabled()

    await user.type(screen.getByLabelText("邮箱验证码"), "12a34 56")
    expect(screen.getByLabelText("邮箱验证码")).toHaveValue("123456")
    await user.type(screen.getByLabelText("密码", { exact: true }), "password")
    await user.type(screen.getByLabelText("确认密码"), "password")
    await user.click(screen.getByRole("button", { name: "注册" }))

    expect(apiMocks.registerInput).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "password",
      displayName: "新制作人",
      code: "123456",
    })
    expect(sessionMocks.acceptSession).toHaveBeenCalledWith(activeSession)
  })

  it.each([
    {
      name: "server cooldown",
      error: new ApiError("cooldown", {
        kind: "http",
        status: 429,
        payload: { retryAfterSeconds: 42 },
      }),
      message: "发送过于频繁，请在 42 秒后重试。",
      buttonName: "42 秒后重发",
    },
    {
      name: "unavailable mail service",
      error: new ApiError("unavailable", { kind: "http", status: 503 }),
      message: "验证码服务暂时不可用，请稍后重试。",
      buttonName: "发送验证码",
    },
    {
      name: "network failure",
      error: new ApiError("offline", { kind: "network" }),
      message: "网络连接失败，请检查连接后重试。",
      buttonName: "发送验证码",
    },
  ])("shows a safe verification state for $name", async (testCase) => {
    apiMocks.verificationSend.mockRejectedValue(testCase.error)
    renderPage("register")
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("邮箱"), "new@example.com")
    await user.click(screen.getByRole("button", { name: "发送验证码" }))

    expect(await screen.findByText(testCase.message)).toBeVisible()
    expect(
      screen.getByRole("button", { name: testCase.buttonName })
    ).toBeVisible()
  })

  it("maps login authentication, rate-limit, and network failures", async () => {
    apiMocks.loginSend
      .mockRejectedValueOnce(
        new ApiError("unauthorized", { kind: "http", status: 401 })
      )
      .mockRejectedValueOnce(
        new ApiError("rate limited", { kind: "http", status: 429 })
      )
      .mockRejectedValueOnce(new ApiError("offline", { kind: "network" }))
    renderPage("login")
    const user = await fillLogin()

    await user.click(screen.getByRole("button", { name: "登录" }))
    expect(await screen.findByText("邮箱或密码不正确。")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "登录" }))
    expect(await screen.findByText("尝试次数过多，请稍后再试。")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "登录" }))
    expect(
      await screen.findByText("网络连接失败，请检查连接后重试。")
    ).toBeVisible()
  })

  it("allows migrated PBKDF2 passwords above the bcrypt byte limit", async () => {
    const legacyPassword = "密".repeat(25)
    apiMocks.loginSend.mockResolvedValueOnce(activeSession)
    renderPage("login")
    const user = userEvent.setup()
    await user.type(
      screen.getByLabelText("邮箱", { exact: true }),
      "legacy@example.com"
    )
    await user.type(
      screen.getByLabelText("密码", { exact: true }),
      legacyPassword
    )
    await user.click(screen.getByRole("button", { name: "登录" }))

    expect(apiMocks.loginInput).toHaveBeenCalledWith({
      email: "legacy@example.com",
      password: legacyPassword,
    })
    expect(sessionMocks.acceptSession).toHaveBeenCalledWith(activeSession)
  })

  it("shows a registration conflict without exposing the API response", async () => {
    apiMocks.registerSend.mockRejectedValue(
      new ApiError("database constraint detail", { kind: "http", status: 409 })
    )
    renderPage("register")
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("显示名称"), "新制作人")
    await user.type(screen.getByLabelText("邮箱"), "new@example.com")
    await user.type(screen.getByLabelText("邮箱验证码"), "123456")
    await user.type(
      screen.getByLabelText("密码", { exact: true }),
      "correct-horse-battery"
    )
    await user.type(screen.getByLabelText("确认密码"), "correct-horse-battery")
    await user.click(screen.getByRole("button", { name: "注册" }))

    expect(
      await screen.findByText("该邮箱已经注册，请直接登录。")
    ).toBeVisible()
    expect(
      screen.queryByText("database constraint detail")
    ).not.toBeInTheDocument()
  })

  it("adopts a successful login session and enters the owner workspace", async () => {
    apiMocks.loginSend.mockResolvedValue(activeSession)
    renderPage("login")
    const user = await fillLogin()
    await user.click(screen.getByRole("button", { name: "登录" }))

    expect(sessionMocks.acceptSession).toHaveBeenCalledWith(activeSession)
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "我的交换空间" })
      ).toBeVisible()
    )
  })

  it("shows the active account without redirecting or calling auth APIs", () => {
    sessionMocks.usePlatformSession.mockReturnValue({
      ...anonymousState(),
      status: "authenticated",
      session: activeSession,
    })
    renderPage("login")

    expect(screen.getByText("当前帐号：测试制作人")).toBeVisible()
    expect(
      screen.getByRole("link", { name: "进入我的交换空间" })
    ).toHaveAttribute("href", "/community/exchange/me")
    expect(apiMocks.loginSend).not.toHaveBeenCalled()
  })
})
