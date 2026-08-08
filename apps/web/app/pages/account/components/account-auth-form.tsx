import {
  CircleCheckIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  LogInIcon,
  MailCheckIcon,
  SendIcon,
  UserPlusIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"

import { usePlatformSession } from "~/components/platform/platform-session-provider"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button, buttonVariants } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "~/components/ui/card"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field"
import { Input } from "~/components/ui/input"
import {
  isApiError,
  loginPlatform,
  platformLoginInputSchema,
  platformRegistrationVerificationInputSchema,
  platformRegisterInputSchema,
  registerPlatform,
  sendPlatformRegistrationVerificationCode,
} from "~/lib/api"

type AccountAuthMode = "login" | "register"
type FieldName =
  | "email"
  | "password"
  | "displayName"
  | "confirmPassword"
  | "code"
type FieldErrors = Partial<Record<FieldName, string>>
type VerificationFeedbackKind = "error" | "success"

interface AccountAuthFormProps {
  mode: AccountAuthMode
}

export function AccountAuthForm({ mode }: AccountAuthFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const platform = usePlatformSession()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [verificationCode, setVerificationCode] = useState("")
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sendingVerification, setSendingVerification] = useState(false)
  const [verificationRequested, setVerificationRequested] = useState(false)
  const [verificationCooldownSeconds, setVerificationCooldownSeconds] =
    useState(0)
  const [verificationFeedback, setVerificationFeedback] = useState("")
  const [verificationFeedbackKind, setVerificationFeedbackKind] =
    useState<VerificationFeedbackKind>("success")
  const [completed, setCompleted] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [requestError, setRequestError] = useState("")

  const isRegister = mode === "register"
  const verificationCoolingDown = verificationCooldownSeconds > 0
  const title = t(
    isRegister ? "platformAuth.register.title" : "platformAuth.login.title"
  )
  const description = t(
    isRegister
      ? "platformAuth.register.description"
      : "platformAuth.login.description"
  )

  useEffect(() => {
    if (completed) {
      void navigate("/community/exchange/me", { replace: true })
    }
  }, [completed, navigate])

  useEffect(() => {
    if (!verificationCoolingDown) return
    const timer = window.setInterval(() => {
      setVerificationCooldownSeconds((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [verificationCoolingDown])

  function clearFieldError(field: FieldName) {
    setFieldErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function validate(): {
    email: string
    password: string
    displayName?: string
    code?: string
  } | null {
    const nextErrors: FieldErrors = {}
    const input = isRegister
      ? { email, password, displayName, code: verificationCode }
      : { email, password }
    const result = isRegister
      ? platformRegisterInputSchema.safeParse(input)
      : platformLoginInputSchema.safeParse(input)

    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0]
        if (field === "email") {
          nextErrors.email = t("platformAuth.emailInvalid")
        } else if (field === "password") {
          nextErrors.password = t(
            isRegister
              ? password.length < 8
                ? "platformAuth.passwordShort"
                : "platformAuth.passwordLong"
              : password.trim()
                ? "platformAuth.passwordLegacyLong"
                : "platformAuth.passwordRequired"
          )
        } else if (field === "displayName") {
          nextErrors.displayName = t(
            displayName.trim()
              ? "platformAuth.displayNameLong"
              : "platformAuth.displayNameRequired"
          )
        } else if (field === "code") {
          nextErrors.code = t("platformAuth.verification.codeInvalid")
        }
      }
    }

    if (isRegister && password !== confirmPassword) {
      nextErrors.confirmPassword = t("platformAuth.passwordMismatch")
    }
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors)
      return null
    }

    return result.success ? result.data : null
  }

  function requestErrorMessage(error: unknown) {
    if (!isApiError(error)) return t("platformAuth.requestFailed")
    if (error.kind === "network") return t("platformAuth.networkError")
    if (error.status === 429) return t("platformAuth.rateLimited")
    if (!isRegister && error.status === 401) {
      return t("platformAuth.invalidCredentials")
    }
    if (isRegister && error.status === 409) {
      return t("platformAuth.emailRegistered")
    }
    if (
      isRegister &&
      (error.code === "PLATFORM_EMAIL_VERIFICATION_INVALID" ||
        error.code === "PLATFORM_EMAIL_VERIFICATION_EXPIRED")
    ) {
      return t("platformAuth.verification.codeRejected")
    }
    return t("platformAuth.requestFailed")
  }

  function retryAfterSeconds(error: unknown) {
    if (!isApiError(error) || error.status !== 429) return 0
    const payload = error.payload
    if (!payload || typeof payload !== "object") return 60
    const value = Reflect.get(payload, "retryAfterSeconds")
    return typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : 60
  }

  async function sendVerificationCode() {
    setRequestError("")
    setVerificationFeedback("")
    setVerificationFeedbackKind("success")
    const result = platformRegistrationVerificationInputSchema.safeParse({
      email,
    })
    if (!result.success) {
      setFieldErrors((current) => ({
        ...current,
        email: t("platformAuth.emailInvalid"),
      }))
      return
    }

    setSendingVerification(true)
    try {
      const response = await sendPlatformRegistrationVerificationCode(
        result.data
      ).send()
      setVerificationRequested(true)
      setVerificationCooldownSeconds(response.retryAfterSeconds)
      setVerificationFeedbackKind("success")
      setVerificationFeedback(
        t("platformAuth.verification.sent", { email: result.data.email })
      )
    } catch (error) {
      setVerificationFeedbackKind("error")
      if (isApiError(error) && error.status === 429) {
        const seconds = retryAfterSeconds(error)
        setVerificationRequested(true)
        setVerificationCooldownSeconds(seconds)
        setVerificationFeedback(
          t("platformAuth.verification.rateLimited", { seconds })
        )
      } else if (isApiError(error) && error.status === 503) {
        setVerificationFeedback(t("platformAuth.verification.unavailable"))
      } else if (isApiError(error) && error.kind === "network") {
        setVerificationFeedback(t("platformAuth.networkError"))
      } else {
        setVerificationFeedback(t("platformAuth.verification.sendFailed"))
      }
    } finally {
      setSendingVerification(false)
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setRequestError("")
    const submission = validate()
    if (!submission) return

    setSubmitting(true)
    try {
      const session = isRegister
        ? await registerPlatform({
            email: submission.email,
            password: submission.password,
            displayName: submission.displayName ?? "",
            code: submission.code ?? "",
          }).send()
        : await loginPlatform({
            email: submission.email,
            password: submission.password,
          }).send()
      platform.acceptSession(session)
      setCompleted(true)
    } catch (error) {
      setRequestError(requestErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (platform.status === "loading") {
    return (
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
      >
        <Alert>
          <LoaderCircleIcon
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <AlertTitle>{t("platformAuth.checkingSession")}</AlertTitle>
        </Alert>
      </main>
    )
  }

  if (platform.session) {
    return (
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
      >
        <section className="w-full space-y-5" aria-labelledby="signed-in-title">
          <Alert>
            <CircleCheckIcon aria-hidden="true" />
            <AlertTitle id="signed-in-title">
              {completed
                ? t(
                    isRegister
                      ? "platformAuth.register.success"
                      : "platformAuth.login.success"
                  )
                : t("platformAuth.signedInTitle")}
            </AlertTitle>
            <AlertDescription>
              {completed
                ? t(
                    isRegister
                      ? "platformAuth.register.successDescription"
                      : "platformAuth.login.successDescription"
                  )
                : t("platformAuth.signedInDescription", {
                    name: platform.session.profile.displayName,
                  })}
            </AlertDescription>
          </Alert>
          <Link
            to="/community/exchange/me"
            className={buttonVariants({
              size: "lg",
              className: "h-11 w-full",
            })}
          >
            {t("platformAuth.enterWorkspace")}
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-xl flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
    >
      <Card className="w-full">
        <CardHeader className="border-b">
          <h1 className="font-heading text-xl/snug font-medium">{title}</h1>
          <CardDescription id={`${mode}-description`}>
            {description}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-5"
            onSubmit={submit}
            noValidate
            aria-describedby={`${mode}-description`}
          >
            {requestError ? (
              <Alert variant="destructive">
                <AlertTitle>{t("platformAuth.requestFailed")}</AlertTitle>
                <AlertDescription>{requestError}</AlertDescription>
              </Alert>
            ) : null}

            <FieldGroup>
              {isRegister ? (
                <Field
                  data-invalid={Boolean(fieldErrors.displayName) || undefined}
                >
                  <FieldLabel htmlFor="platform-display-name">
                    {t("platformAuth.displayName")}
                  </FieldLabel>
                  <Input
                    id="platform-display-name"
                    name="displayName"
                    autoComplete="name"
                    maxLength={80}
                    autoFocus
                    value={displayName}
                    aria-invalid={Boolean(fieldErrors.displayName)}
                    aria-describedby={
                      fieldErrors.displayName
                        ? "platform-display-name-error"
                        : undefined
                    }
                    onChange={(event) => {
                      setDisplayName(event.target.value)
                      clearFieldError("displayName")
                    }}
                  />
                  <FieldError id="platform-display-name-error">
                    {fieldErrors.displayName}
                  </FieldError>
                </Field>
              ) : null}

              <Field data-invalid={Boolean(fieldErrors.email) || undefined}>
                <FieldLabel htmlFor="platform-email">
                  {t("platformAuth.email")}
                </FieldLabel>
                <Input
                  id="platform-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={320}
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={!isRegister}
                  value={email}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={
                    [
                      fieldErrors.email ? "platform-email-error" : "",
                      verificationFeedback
                        ? "platform-verification-feedback"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearFieldError("email")
                    setVerificationCode("")
                    setVerificationRequested(false)
                    setVerificationCooldownSeconds(0)
                    setVerificationFeedback("")
                    setVerificationFeedbackKind("success")
                    clearFieldError("code")
                  }}
                />
                <FieldError id="platform-email-error">
                  {fieldErrors.email}
                </FieldError>
                {isRegister ? (
                  <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p
                      id="platform-verification-feedback"
                      className={
                        verificationFeedbackKind === "error"
                          ? "text-sm text-destructive"
                          : "text-sm text-muted-foreground"
                      }
                      role={
                        verificationFeedbackKind === "error"
                          ? "alert"
                          : "status"
                      }
                      aria-live="polite"
                    >
                      {verificationFeedback ||
                        t("platformAuth.verification.deliveryHint")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={
                        submitting ||
                        sendingVerification ||
                        verificationCoolingDown
                      }
                      onClick={() => void sendVerificationCode()}
                    >
                      {sendingVerification ? (
                        <LoaderCircleIcon
                          data-icon="inline-start"
                          className="animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : verificationRequested ? (
                        <MailCheckIcon
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                      ) : (
                        <SendIcon data-icon="inline-start" aria-hidden="true" />
                      )}
                      {sendingVerification
                        ? t("platformAuth.verification.sending")
                        : verificationCoolingDown
                          ? t("platformAuth.verification.resendCountdown", {
                              seconds: verificationCooldownSeconds,
                            })
                          : t(
                              verificationRequested
                                ? "platformAuth.verification.resend"
                                : "platformAuth.verification.send"
                            )}
                    </Button>
                  </div>
                ) : null}
              </Field>

              {isRegister ? (
                <Field data-invalid={Boolean(fieldErrors.code) || undefined}>
                  <FieldLabel htmlFor="platform-verification-code">
                    {t("platformAuth.verification.code")}
                  </FieldLabel>
                  <Input
                    id="platform-verification-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={verificationCode}
                    aria-invalid={Boolean(fieldErrors.code)}
                    aria-describedby={
                      fieldErrors.code
                        ? "platform-verification-code-error"
                        : "platform-verification-code-hint"
                    }
                    onChange={(event) => {
                      setVerificationCode(
                        event.target.value.replace(/\D/g, "").slice(0, 6)
                      )
                      clearFieldError("code")
                    }}
                  />
                  <p
                    id="platform-verification-code-hint"
                    className="text-sm text-muted-foreground"
                  >
                    {t("platformAuth.verification.codeHint")}
                  </p>
                  <FieldError id="platform-verification-code-error">
                    {fieldErrors.code}
                  </FieldError>
                </Field>
              ) : null}

              <Field data-invalid={Boolean(fieldErrors.password) || undefined}>
                <FieldLabel htmlFor="platform-password">
                  {t("platformAuth.password")}
                </FieldLabel>
                <div className="relative">
                  <Input
                    id="platform-password"
                    name="password"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete={
                      isRegister ? "new-password" : "current-password"
                    }
                    maxLength={isRegister ? 72 : undefined}
                    className="pr-10"
                    value={password}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={
                      fieldErrors.password
                        ? "platform-password-error"
                        : undefined
                    }
                    onChange={(event) => {
                      setPassword(event.target.value)
                      clearFieldError("password")
                      clearFieldError("confirmPassword")
                    }}
                  />
                  <button
                    type="button"
                    className="absolute top-0 right-0 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    aria-label={t(
                      passwordVisible
                        ? "platformAuth.hidePassword"
                        : "platformAuth.showPassword"
                    )}
                    aria-pressed={passwordVisible}
                    onClick={() => setPasswordVisible((visible) => !visible)}
                  >
                    {passwordVisible ? (
                      <EyeOffIcon className="size-4" aria-hidden="true" />
                    ) : (
                      <EyeIcon className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <FieldError id="platform-password-error">
                  {fieldErrors.password}
                </FieldError>
              </Field>

              {isRegister ? (
                <Field
                  data-invalid={
                    Boolean(fieldErrors.confirmPassword) || undefined
                  }
                >
                  <FieldLabel htmlFor="platform-confirm-password">
                    {t("platformAuth.confirmPassword")}
                  </FieldLabel>
                  <Input
                    id="platform-confirm-password"
                    name="confirmPassword"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete="new-password"
                    maxLength={72}
                    value={confirmPassword}
                    aria-invalid={Boolean(fieldErrors.confirmPassword)}
                    aria-describedby={
                      fieldErrors.confirmPassword
                        ? "platform-confirm-password-error"
                        : undefined
                    }
                    onChange={(event) => {
                      setConfirmPassword(event.target.value)
                      clearFieldError("confirmPassword")
                    }}
                  />
                  <FieldError id="platform-confirm-password-error">
                    {fieldErrors.confirmPassword}
                  </FieldError>
                </Field>
              ) : null}
            </FieldGroup>

            <Button
              type="submit"
              size="lg"
              className="h-11 w-full"
              disabled={submitting}
            >
              {submitting ? (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : isRegister ? (
                <UserPlusIcon data-icon="inline-start" aria-hidden="true" />
              ) : (
                <LogInIcon data-icon="inline-start" aria-hidden="true" />
              )}
              {t(
                submitting
                  ? isRegister
                    ? "platformAuth.register.submitting"
                    : "platformAuth.login.submitting"
                  : isRegister
                    ? "platformAuth.register.submit"
                    : "platformAuth.login.submit"
              )}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              {t(
                isRegister
                  ? "platformAuth.register.switchPrompt"
                  : "platformAuth.login.switchPrompt"
              )}{" "}
              <Link
                to={isRegister ? "/account/login" : "/account/register"}
                className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
              >
                {t(
                  isRegister
                    ? "platformAuth.register.switchAction"
                    : "platformAuth.login.switchAction"
                )}
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
