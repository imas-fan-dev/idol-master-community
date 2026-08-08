import { useRequest } from "alova/client"
import { LayoutDashboardIcon } from "lucide-react"
import { Link } from "react-router"

import { getAdminSession, hasBackofficeSessionHint } from "~/lib/api"
import { cn } from "~/lib/utils"

export function AdminReturnShortcut({ className }: { className?: string }) {
  const shouldValidateSession = hasBackofficeSessionHint()
  const { data, error, onError } = useRequest(getAdminSession(), {
    immediate: shouldValidateSession,
  })
  onError(() => undefined)

  if (!shouldValidateSession || error || data?.user.dept !== "op") {
    return null
  }

  return (
    <Link
      to="/admin"
      data-admin-return-shortcut
      className={cn(
        "fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 inline-flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-admin-ink px-3 text-sm font-semibold text-admin-ink-foreground shadow-lg shadow-black/15 transition-colors hover:bg-admin-ink-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:right-6 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]",
        className
      )}
      aria-label="返回管理工作台"
    >
      <LayoutDashboardIcon className="size-4" aria-hidden="true" />
      <span>管理工作台</span>
    </Link>
  )
}
