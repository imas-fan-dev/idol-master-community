import {
  Building2Icon,
  ChevronRightIcon,
  CreditCardIcon,
  EyeIcon,
  LayoutGridIcon,
  MapPinIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SearchIcon,
  UserRoundCogIcon,
} from "lucide-react"
import { useState, type FormEvent } from "react"
import { Link } from "react-router"

import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import { WikiTransformedImage } from "~/components/shared/wiki-transformed-image"
import { Button, buttonVariants } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import type { FudabaOffice, FudabaSeries } from "~/lib/api"
import { cn } from "~/lib/utils"

interface ExchangeDiscoveryRailProps {
  cityDraft: string
  seriesCode: string
  openOnly: boolean
  series: FudabaSeries[]
  offices: FudabaOffice[]
  cardCount: number
  refreshing: boolean
  error: string | null
  hasFilters: boolean
  onCityDraftChange: (value: string) => void
  onCitySubmit: (event: FormEvent<HTMLFormElement>) => void
  onSeriesChange: (seriesCode: string | null) => void
  onOpenChange: (openOnly: boolean) => void
  onResetFilters: () => void
  onRefresh: () => void
  onOpenOffices: () => void
  onOpenCards: () => void
}

function SeriesChannelIcon({ series }: { series: FudabaSeries }) {
  return (
    <StatefulSeriesChannelIcon
      key={`${series.code}:${series.iconUrl ?? ""}`}
      series={series}
    />
  )
}

function StatefulSeriesChannelIcon({ series }: { series: FudabaSeries }) {
  const [failed, setFailed] = useState(false)
  const showIcon = Boolean(series.iconUrl) && !failed

  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm",
        showIcon && "border bg-background p-0.5"
      )}
      style={{
        backgroundColor: showIcon ? undefined : series.color,
        borderColor: showIcon ? series.color : undefined,
      }}
      aria-hidden="true"
    >
      {showIcon ? (
        <WikiTransformedImage
          src={series.iconUrl ?? undefined}
          alt=""
          transform={series.imageTransform}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  )
}

function officeSeriesLabel(
  office: FudabaOffice,
  series: readonly FudabaSeries[]
) {
  const labels = new Map(series.map((item) => [item.code, item.displayName]))
  return office.seriesCodes
    .slice(0, 2)
    .map((code) => labels.get(code) ?? code)
    .join(" / ")
}

export function ExchangeDiscoveryRail({
  cityDraft,
  seriesCode,
  openOnly,
  series,
  offices,
  cardCount,
  refreshing,
  error,
  hasFilters,
  onCityDraftChange,
  onCitySubmit,
  onSeriesChange,
  onOpenChange,
  onResetFilters,
  onRefresh,
  onOpenOffices,
  onOpenCards,
}: ExchangeDiscoveryRailProps) {
  return (
    <aside
      className="relative z-10 hidden h-full w-80 shrink-0 flex-col overflow-hidden border-r bg-background/97 shadow-[8px_0_24px_rgb(15_23_42/0.08)] lg:flex"
      aria-label="交换发现栏"
    >
      <SeriesAccentStrip className="absolute inset-x-0 top-0 z-10 h-1" />

      <header className="shrink-0 border-b px-5 pt-6 pb-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-accent text-primary">
            <RadioTowerIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-primary">
              P-CARD EXCHANGE · SERIES SIGNAL
            </p>
            <h1 className="mt-1 text-lg font-semibold">名片交换信号地图</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {offices.length} 个事务所 · {cardCount} 张名片
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="刷新交换区"
            title="刷新"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCwIcon
              className={cn(
                refreshing && "animate-spin motion-reduce:animate-none"
              )}
              aria-hidden="true"
            />
          </Button>
        </div>

        <form className="mt-4 flex gap-2" onSubmit={onCitySubmit}>
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="desktop-rail-exchange-city"
              value={cityDraft}
              maxLength={100}
              placeholder="搜索城市"
              aria-label="搜索城市"
              className="bg-background pl-9"
              onChange={(event) => onCityDraftChange(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" variant="outline" size="icon">
            <SearchIcon aria-hidden="true" />
            <span className="sr-only">按城市查找</span>
          </Button>
        </form>

        <div className="mt-3 flex items-center justify-between gap-3">
          <Label
            htmlFor="desktop-rail-open-only"
            className="flex min-w-0 items-center gap-2 text-xs font-normal"
          >
            <Checkbox
              id="desktop-rail-open-only"
              checked={openOnly}
              onCheckedChange={(checked) => onOpenChange(checked === true)}
            />
            仅看开放事务所
          </Label>
          {hasFilters ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onResetFilters}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      </header>

      <section className="shrink-0 border-b p-4" aria-label="企划频道">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="text-xs font-semibold">企划频道</h2>
          <span className="text-xs text-muted-foreground">
            {series.length + 1} 个频道
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant={seriesCode ? "ghost" : "secondary"}
            size="sm"
            className="h-9 min-w-0 justify-start px-2.5"
            aria-pressed={!seriesCode}
            onClick={() => onSeriesChange(null)}
          >
            <LayoutGridIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">全部企划</span>
          </Button>
          {series.map((item) => (
            <Button
              key={item.code}
              type="button"
              variant={seriesCode === item.code ? "secondary" : "ghost"}
              size="sm"
              className="h-9 min-w-0 justify-start px-2.5"
              aria-pressed={seriesCode === item.code}
              onClick={() => onSeriesChange(item.code)}
            >
              <SeriesChannelIcon series={item} />
              <span className="min-w-0 flex-1 truncate text-left">
                {item.displayName}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground">
                {item.activeOfficeCount}
              </span>
            </Button>
          ))}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col" aria-label="附近事务所">
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
          <h2 className="text-xs font-semibold">附近事务所</h2>
          <span className="text-xs text-muted-foreground">
            {offices.length} 个地点
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-y">
          {offices.length ? (
            <div className="divide-y">
              {offices.map((office) => (
                <Link
                  key={office.id}
                  to={`/community/exchange/offices/${encodeURIComponent(office.slug)}`}
                  className="group relative flex min-w-0 gap-3 px-5 py-3 transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                >
                  <span
                    className="mt-1 block h-10 w-1 shrink-0 rounded-sm"
                    style={{ backgroundColor: office.accent }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium">
                      {office.name}
                    </strong>
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <MapPinIcon
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{office.city}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">
                        {officeSeriesLabel(office, series) || "综合企划"}
                      </span>
                    </span>
                    <span className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <EyeIcon className="size-3" aria-hidden="true" />
                      {office.visitorCount.toLocaleString("zh-CN")} 次访问
                    </span>
                  </span>
                  <ChevronRightIcon
                    className="mt-3 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex h-full min-h-28 items-center justify-center px-5 text-center text-sm text-muted-foreground">
              当前筛选下没有公开事务所
            </div>
          )}
        </div>
      </section>

      {error ? (
        <p
          className="shrink-0 border-b px-5 py-2 text-xs text-destructive"
          role="status"
        >
          {error}。地图结果仍可继续使用。
        </p>
      ) : null}

      <nav
        className="grid shrink-0 grid-cols-3 gap-2 p-3"
        aria-label="交换快捷操作"
      >
        <Button type="button" variant="outline" onClick={onOpenOffices}>
          <Building2Icon aria-hidden="true" />
          事务所
        </Button>
        <Button type="button" variant="outline" onClick={onOpenCards}>
          <CreditCardIcon aria-hidden="true" />
          名片
        </Button>
        <Link
          to="/community/exchange/me"
          className={buttonVariants({ variant: "outline" })}
        >
          <UserRoundCogIcon aria-hidden="true" />
          管理
        </Link>
      </nav>
    </aside>
  )
}
