import {
  CircleAlertIcon,
  CreditCardIcon,
  CircleUserRoundIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  UserPlusIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"

import { usePlatformSession } from "~/components/platform/platform-session-provider"
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar"
import { Badge } from "~/components/ui/badge"
import { Button, buttonVariants } from "~/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover"

export function PlatformAccountMenu() {
  const { t } = useTranslation()
  const platform = usePlatformSession()
  const displayName = platform.session?.profile.displayName ?? ""
  const restricted = platform.status === "restricted"
  const triggerLabel =
    platform.status === "loading"
      ? t("platformAccount.loadingLabel")
      : platform.status === "error"
        ? t("platformAccount.error")
        : platform.status === "anonymous"
          ? t("platformAccount.anonymousLabel")
          : t(
              restricted
                ? "platformAccount.restrictedLabel"
                : "platformAccount.authenticatedLabel",
              { name: displayName }
            )

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            className="shrink-0"
            aria-label={triggerLabel}
          />
        }
      >
        {platform.status === "loading" ? (
          <LoaderCircleIcon
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
          />
        ) : platform.status === "error" ? (
          <CircleAlertIcon aria-hidden="true" />
        ) : platform.session ? (
          <Avatar size="default">
            {platform.session.profile.avatarUrl ? (
              <AvatarImage
                src={platform.session.profile.avatarUrl}
                alt={t("platformAccount.avatarAlt", { name: displayName })}
                referrerPolicy="no-referrer"
              />
            ) : null}
            <AvatarFallback>
              {displayName.trim().slice(0, 1) || t("platformAccount.fallback")}
            </AvatarFallback>
          </Avatar>
        ) : (
          <CircleUserRoundIcon aria-hidden="true" />
        )}
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-64">
        <PopoverTitle>{t("platformAccount.title")}</PopoverTitle>
        {platform.status === "anonymous" ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("platformAccount.anonymous")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Link
                to="/account/login"
                className={buttonVariants({
                  variant: "default",
                  size: "sm",
                  className: "w-full",
                })}
              >
                <LogInIcon data-icon="inline-start" aria-hidden="true" />
                {t("platformAccount.login")}
              </Link>
              <Link
                to="/account/register"
                className={buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "w-full",
                })}
              >
                <UserPlusIcon data-icon="inline-start" aria-hidden="true" />
                {t("platformAccount.register")}
              </Link>
            </div>
          </div>
        ) : platform.status === "loading" ? (
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {t("platformAccount.loading")}
          </p>
        ) : platform.status === "error" ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("platformAccount.error")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void platform.reload()}
            >
              <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
              {t("platformAccount.retry")}
            </Button>
          </div>
        ) : platform.session ? (
          <div className="mt-3 space-y-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar size="lg">
                {platform.session.profile.avatarUrl ? (
                  <AvatarImage
                    src={platform.session.profile.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                <AvatarFallback>
                  {displayName.trim().slice(0, 1) ||
                    t("platformAccount.fallback")}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{displayName}</p>
                {restricted ? (
                  <Badge
                    variant="secondary"
                    className="mt-1 bg-warning/25 text-warning-foreground"
                  >
                    {t("platformAccount.restricted")}
                  </Badge>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("platformAccount.authenticated")}
                  </p>
                )}
              </div>
            </div>
            <Link
              to="/community/exchange/me"
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "w-full",
              })}
            >
              <CreditCardIcon data-icon="inline-start" aria-hidden="true" />
              {t("platformAccount.myCards")}
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void platform.logout()}
            >
              <LogOutIcon data-icon="inline-start" aria-hidden="true" />
              {t("platformAccount.logout")}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
