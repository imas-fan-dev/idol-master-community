import { BookOpenTextIcon, MenuIcon } from "lucide-react"
import { useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { Link, NavLink } from "react-router"

import { BrandWordmark } from "~/components/shared/brand-wordmark"
import { PlatformAccountMenu } from "~/components/platform/platform-account-menu"
import { Button } from "~/components/ui/button"
import { ThemeToggle } from "~/components/shared/theme-toggle"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet"
import { cn } from "~/lib/utils"

const navigation = [
  { to: "/", label: "navigation.home", end: true },
  { to: "/events", label: "navigation.events", end: false },
  {
    to: "/recommendations",
    label: "navigation.recommendations",
    end: false,
  },
  { to: "/live", label: "navigation.live", end: false },
  { to: "/community", label: "navigation.community", end: false },
  { to: "/about", label: "navigation.about", end: true },
] as const

const subscribeToHydration = () => () => undefined

function useHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  )
}

function desktopLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    "relative flex h-16 items-center px-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
    "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:transition-transform",
    isActive ? "text-foreground after:scale-x-100" : "after:scale-x-0"
  )
}

export function SiteHeader() {
  const { t } = useTranslation()
  const hydrated = useHydrated()
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:gap-6 lg:px-8">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-3"
          aria-label={t("brand.homeLabel")}
        >
          <BrandWordmark className="h-7 sm:h-9" alt="" />
          <span className="hidden border-l pl-3 text-xs font-semibold text-muted-foreground sm:inline">
            {t("brand.name")}
          </span>
        </Link>

        <nav
          className="ml-auto hidden items-center gap-5 lg:flex"
          aria-label={t("navigation.mainLabel")}
        >
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={desktopLinkClass}
            >
              {t(item.label)}
            </NavLink>
          ))}
        </nav>

        <Link
          to="/wiki"
          className="hidden items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:inline-flex"
        >
          {t("navigation.storySite")}
          <BookOpenTextIcon aria-hidden="true" className="size-3.5" />
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
          <PlatformAccountMenu />
          <ThemeToggle />

          <Sheet
            open={mobileNavigationOpen}
            onOpenChange={setMobileNavigationOpen}
          >
            <SheetTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="lg:hidden"
                  disabled={!hydrated}
                  aria-label={t("navigation.open")}
                />
              }
            >
              <MenuIcon data-icon="inline-start" />
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(88vw,22rem)]">
              <SheetHeader className="border-b">
                <SheetTitle>{t("navigation.title")}</SheetTitle>
                <SheetDescription>
                  {t("navigation.description")}
                </SheetDescription>
              </SheetHeader>
              <nav
                className="flex flex-col px-2"
                aria-label={t("navigation.mobileLabel")}
              >
                {navigation.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={() => setMobileNavigationOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "rounded-md p-3 text-sm font-medium hover:bg-muted",
                        isActive && "bg-muted text-primary"
                      )
                    }
                  >
                    {t(item.label)}
                  </NavLink>
                ))}
                <Link
                  to="/wiki"
                  onClick={() => setMobileNavigationOpen(false)}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary p-3 text-sm font-medium text-primary-foreground"
                >
                  {t("navigation.storySite")}
                  <BookOpenTextIcon aria-hidden="true" className="size-3.5" />
                </Link>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
