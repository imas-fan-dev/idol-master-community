import { useRequest } from "alova/client"
import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  CalendarDaysIcon,
  ChevronRightIcon,
  ContactRoundIcon,
  HistoryIcon,
  HomeIcon,
  InfoIcon,
  LayoutDashboardIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  MapPinCheckIcon,
  MapPinnedIcon,
  MegaphoneIcon,
  NewspaperIcon,
  PackageOpenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  ShieldXIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import { Link, Navigate, NavLink, Outlet, useNavigate } from "react-router"
import { toast } from "sonner"

import { Badge } from "~/components/ui/badge"
import { BrandWordmark } from "~/components/shared/brand-wordmark"
import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import { Button, buttonVariants } from "~/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import { cn } from "~/lib/utils"
import { getAdminSession, isApiError, logoutAdmin } from "~/lib/api"

const navigation: Array<{
  to: string
  label: string
  description: string
  icon: LucideIcon
  accent: string
  end?: boolean
  superOnly?: boolean
}> = [
  {
    to: "/admin",
    label: "工作台",
    description: "业务入口总览",
    icon: HomeIcon,
    accent: "bg-franchise-765",
    end: true,
  },
  {
    to: "/admin/events",
    label: "社区活动",
    description: "公开活动发布",
    icon: MegaphoneIcon,
    accent: "bg-franchise-765",
  },
  {
    to: "/admin/homepage",
    label: "首页板块",
    description: "导航、友链与站点支持",
    icon: LayoutDashboardIcon,
    accent: "bg-franchise-sc",
  },
  {
    to: "/admin/information",
    label: "活动资讯",
    description: "活动资讯与同人活动",
    icon: CalendarDaysIcon,
    accent: "bg-franchise-cg",
  },
  {
    to: "/admin/about",
    label: "关于本站",
    description: "站点介绍与贡献名单",
    icon: InfoIcon,
    accent: "bg-primary",
  },
  {
    to: "/admin/producer-map",
    label: "制作人地图",
    description: "地区资料与社群名录",
    icon: MapPinnedIcon,
    accent: "bg-franchise-sidem",
  },
  {
    to: "/admin/community/exchange",
    label: "事务所位置",
    description: "公开区域位置审核",
    icon: MapPinCheckIcon,
    accent: "bg-franchise-ml",
  },
  {
    to: "/admin/recommendations",
    label: "向您推荐",
    description: "首页推荐与封面",
    icon: NewspaperIcon,
    accent: "bg-franchise-ml",
  },
  {
    to: "/admin/cards",
    label: "名片审核",
    description: "制作人名片投稿",
    icon: ContactRoundIcon,
    accent: "bg-franchise-765",
  },
  {
    to: "/admin/site-packages",
    label: "页面包",
    description: "页面版本与发布",
    icon: PackageOpenIcon,
    accent: "bg-franchise-sidem",
  },
  {
    to: "/admin/stories",
    label: "剧情内容",
    description: "剧情角色素材",
    icon: BookOpenTextIcon,
    accent: "bg-franchise-sc",
  },
  {
    to: "/admin/chronicle",
    label: "活动纪年",
    description: "活动图片审核",
    icon: HistoryIcon,
    accent: "bg-franchise-gk",
  },
  {
    to: "/admin/accounts",
    label: "管理员账号",
    description: "运营账号与访问控制",
    icon: UsersRoundIcon,
    accent: "bg-franchise-cg",
    superOnly: true,
  },
]

function navClass(
  { isActive }: { isActive: boolean },
  sidebarCollapsed: boolean
) {
  return cn(
    "group relative flex min-h-12 shrink-0 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:min-h-14",
    sidebarCollapsed && "lg:justify-center lg:gap-0 lg:px-0",
    isActive
      ? "bg-admin-ink-muted text-admin-ink-foreground"
      : "text-admin-ink-subtle hover:bg-admin-ink-muted hover:text-admin-ink-foreground"
  )
}

function AdminAccessState({
  icon: Icon,
  label,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  label: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="min-h-svh bg-background">
      <SeriesAccentStrip className="h-1" />
      <section className="mx-auto flex min-h-[calc(100svh-0.25rem)] w-full max-w-xl flex-col justify-center px-6 py-12 sm:px-10">
        <span className="flex size-11 items-center justify-center rounded-md bg-destructive/10 text-destructive">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-6 text-xs font-semibold text-primary">{label}</p>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 max-w-md text-sm/6 text-muted-foreground">
          {description}
        </p>
        <div className="mt-7 flex flex-wrap gap-3">{children}</div>
      </section>
    </main>
  )
}

function AdminAccessDenied() {
  return (
    <AdminAccessState
      icon={ShieldXIcon}
      label="ACCESS RESTRICTED"
      title="无法访问管理工作台"
      description="当前登录账号没有内容运营权限。"
    >
      <Button render={<Link to="/admin/login" />} nativeButton={false}>
        <LogInIcon data-icon="inline-start" />
        切换管理账号
      </Button>
      <Button variant="outline" render={<Link to="/" />} nativeButton={false}>
        <ArrowLeftIcon data-icon="inline-start" />
        返回站点
      </Button>
    </AdminAccessState>
  )
}

function AdminSessionFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <AdminAccessState
      icon={RefreshCwIcon}
      label="SESSION CHECK FAILED"
      title="无法验证管理会话"
      description="会话服务暂时不可用，请重试。"
    >
      <Button type="button" onClick={onRetry}>
        <RefreshCwIcon data-icon="inline-start" />
        重新验证
      </Button>
      <Button variant="outline" render={<Link to="/" />} nativeButton={false}>
        <ArrowLeftIcon data-icon="inline-start" />
        返回站点
      </Button>
    </AdminAccessState>
  )
}

function isExpiredSession(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 401 || error.code === "CSRF_TOKEN_MISSING")
  )
}

export default function AdminLayout() {
  const navigate = useNavigate()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { data, loading, error, onError, send } = useRequest(getAdminSession())
  onError(() => undefined)

  if (isExpiredSession(error)) {
    return <Navigate to="/admin/login" replace />
  }

  if (isApiError(error) && error.status === 403) {
    return <AdminAccessDenied />
  }

  if (error) {
    return <AdminSessionFailure onRetry={() => void send()} />
  }

  if (loading || !data) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-5 bg-background">
        <SeriesAccentStrip className="h-1 w-32 overflow-hidden rounded-full" />
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon
            className="size-4 animate-spin"
            aria-hidden="true"
          />
          正在验证管理会话
        </span>
      </main>
    )
  }

  if (data.user.dept !== "op") {
    return <AdminAccessDenied />
  }

  async function logout() {
    try {
      await logoutAdmin().send()
    } catch {
      // Clear the local view even if the already-expired server session rejects.
    }
    toast.success("已退出管理工作台")
    void navigate("/admin/login", { replace: true })
  }

  return (
    <div className="min-h-svh bg-background">
      <SeriesAccentStrip className="h-1" />
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-400 items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/admin" className="flex min-w-0 items-center gap-3">
            <BrandWordmark className="h-8" />
            <span className="hidden border-l pl-3 text-xs font-semibold text-muted-foreground sm:inline">
              内容运营台
            </span>
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <Badge variant="outline" className="hidden max-w-52 sm:flex">
              <UserRoundIcon data-icon="inline-start" aria-hidden="true" />
              <span className="truncate">
                {data.user.producername || data.user.username}
              </span>
            </Badge>
            <Badge
              variant={
                data.user.adminRole === "super_admin" ? "default" : "secondary"
              }
              className="hidden md:flex"
            >
              {data.user.adminRole === "super_admin"
                ? "最高管理员"
                : "一般管理员"}
            </Badge>
            <Link
              to="/"
              aria-label="返回主站"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <HomeIcon data-icon="inline-start" aria-hidden="true" />
              <span className="hidden sm:inline">返回主站</span>
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void logout()}
            >
              <LogOutIcon data-icon="inline-start" />
              退出
            </Button>
          </div>
        </div>
      </header>

      <div
        className={cn(
          "mx-auto grid w-full max-w-400 grid-cols-[minmax(0,1fr)] transition-[grid-template-columns] duration-200 motion-reduce:transition-none",
          sidebarCollapsed
            ? "lg:grid-cols-[4.5rem_minmax(0,1fr)]"
            : "lg:grid-cols-[17rem_minmax(0,1fr)]"
        )}
      >
        <aside
          className="min-w-0 border-b bg-admin-ink text-admin-ink-foreground lg:min-h-[calc(100svh-4.25rem)] lg:border-r lg:border-b-0"
          data-collapsed={sidebarCollapsed}
        >
          <TooltipProvider>
            <nav
              id="admin-navigation"
              className={cn(
                "flex max-w-full min-w-0 gap-1 overflow-x-auto p-3 lg:sticky lg:top-16 lg:flex-col lg:gap-2",
                sidebarCollapsed ? "lg:p-3" : "lg:p-5"
              )}
              aria-label="管理业务"
            >
              <div
                className={cn(
                  "mb-3 hidden items-start lg:flex",
                  sidebarCollapsed
                    ? "justify-center"
                    : "justify-between gap-3 px-3"
                )}
              >
                {sidebarCollapsed ? null : (
                  <div>
                    <p className="text-[0.68rem] font-semibold text-admin-ink-subtle uppercase">
                      IMSWEB OPERATIONS
                    </p>
                    <p className="mt-2 text-sm font-medium">内容中枢</p>
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-admin-ink-subtle hover:bg-admin-ink-muted hover:text-admin-ink-foreground"
                        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                        aria-controls="admin-navigation"
                        aria-expanded={!sidebarCollapsed}
                        onClick={() =>
                          setSidebarCollapsed((collapsed) => !collapsed)
                        }
                      />
                    }
                  >
                    {sidebarCollapsed ? (
                      <PanelLeftOpenIcon aria-hidden="true" />
                    ) : (
                      <PanelLeftCloseIcon aria-hidden="true" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                  </TooltipContent>
                </Tooltip>
              </div>
              {navigation
                .filter(
                  (item) =>
                    !item.superOnly || data.user.adminRole === "super_admin"
                )
                .map((item) => {
                  const link = (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={(state) => navClass(state, sidebarCollapsed)}
                    >
                      <span
                        className={cn(
                          "absolute inset-y-3 left-0 w-0.5 rounded-full opacity-0 transition-opacity group-aria-[current=page]:opacity-100",
                          item.accent
                        )}
                        aria-hidden="true"
                      />
                      <item.icon
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span
                        className={cn(
                          "min-w-0 whitespace-nowrap lg:flex lg:flex-col",
                          sidebarCollapsed && "lg:sr-only"
                        )}
                      >
                        <span>{item.label}</span>
                        <span className="hidden text-[10.88px]/4 font-normal text-admin-ink-subtle lg:block">
                          {item.description}
                        </span>
                      </span>
                      <ChevronRightIcon
                        className={cn(
                          "ml-auto hidden size-3 opacity-50 transition-transform group-hover:translate-x-0.5 lg:block",
                          sidebarCollapsed && "lg:hidden"
                        )}
                        aria-hidden="true"
                      />
                    </NavLink>
                  )

                  if (!sidebarCollapsed) {
                    return link
                  }

                  return (
                    <Tooltip key={item.to}>
                      <TooltipTrigger render={link} />
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  )
                })}
            </nav>
          </TooltipProvider>
        </aside>
        <main className="min-w-0 bg-muted/20 px-4 py-7 sm:px-6 lg:px-8 lg:py-9 xl:px-10">
          <Outlet context={{ adminSession: data.user }} />
        </main>
      </div>
    </div>
  )
}
