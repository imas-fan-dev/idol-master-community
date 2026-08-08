import { Outlet, useLocation } from "react-router"
import { useTranslation } from "react-i18next"

import { AdminReturnShortcut } from "~/components/shared/admin-return-shortcut"
import { PlatformSessionProvider } from "~/components/platform/platform-session-provider"
import { BackToTop } from "~/components/shared/back-to-top"
import { SeriesIconBackground } from "~/components/shared/series-icon-background"
import { SiteFooter } from "~/components/shared/site-footer"
import { SiteHeader } from "~/components/shared/site-header"
import { cn } from "~/lib/utils"

export default function PublicLayout() {
  const { t } = useTranslation()
  const location = useLocation()
  const normalizedPathname =
    location.pathname.length > 1
      ? location.pathname.replace(/\/+$/, "")
      : location.pathname
  const isExchangeMap = normalizedPathname === "/community/exchange"
  const isWikiCatalog =
    normalizedPathname === "/wiki" || normalizedPathname === "/wiki/modern"
  const isModernStory =
    normalizedPathname === "/story" || normalizedPathname === "/story/modern"

  return (
    <PlatformSessionProvider>
      <div
        className={cn(
          "relative isolate flex min-h-svh flex-col",
          isExchangeMap && "h-dvh min-h-0 overflow-hidden"
        )}
      >
        <a
          href="#main-content"
          className="fixed top-2 left-2 z-100 -translate-y-16 rounded-md bg-background px-3 py-2 text-sm font-medium shadow-sm focus:translate-y-0"
        >
          {t("accessibility.skipToContent")}
        </a>
        {isExchangeMap ? null : <SeriesIconBackground />}
        <SiteHeader />
        <div
          className={cn(
            "relative flex-1 bg-background/75 sm:bg-background/60",
            isModernStory ? "z-20" : "z-10",
            isExchangeMap && "min-h-0 bg-[#e8f2f4] sm:bg-[#e8f2f4]"
          )}
        >
          <Outlet />
        </div>
        {isExchangeMap ? null : (
          <>
            <div className="relative z-10">
              <SiteFooter />
            </div>
            <div className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-end gap-2 sm:right-6 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]">
              <BackToTop
                className={cn("static", isWikiCatalog && "max-md:hidden")}
              />
              <AdminReturnShortcut className="static" />
            </div>
          </>
        )}
      </div>
    </PlatformSessionProvider>
  )
}
