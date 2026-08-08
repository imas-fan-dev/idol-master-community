import {
  Building2Icon,
  CreditCardIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  MapPinnedIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserRoundCogIcon,
  XIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react"
import { Link, useSearchParams } from "react-router"

import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button, buttonVariants } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet"
import { Skeleton } from "~/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs"
import {
  getFudabaCardPage,
  getFudabaOfficePage,
  getFudabaSeries,
  isApiError,
  type FudabaCard,
  type FudabaCardPage,
  type FudabaOffice,
  type FudabaOfficePage,
  type FudabaSeries,
} from "~/lib/api"
import { cn } from "~/lib/utils"
import { CommunityExchangeMapSection } from "./community-exchange-map-section"
import { ExchangeDiscoveryRail } from "./components/exchange-discovery-rail"
import { ExchangeCard, OfficeCard } from "./exchange-components"

type DiscoveryPhase = "loading" | "ready" | "closed" | "error"
type DirectoryView = "offices" | "cards"

type DiscoveryState = {
  phase: DiscoveryPhase
  series: FudabaSeries[]
  offices: FudabaOffice[]
  officePageInfo: FudabaOfficePage["pageInfo"]
  cards: FudabaCard[]
  cardPageInfo: FudabaCardPage["pageInfo"]
  error: string | null
}

const emptyPageInfo = { hasNextPage: false, nextCursor: null }
const initialState: DiscoveryState = {
  phase: "loading",
  series: [],
  offices: [],
  officePageInfo: emptyPageInfo,
  cards: [],
  cardPageInfo: emptyPageInfo,
  error: null,
}

function deduplicateById<T extends { id: string }>(
  current: T[],
  incoming: T[]
) {
  const known = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !known.has(item.id))]
}

function discoveryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "社区交换数据暂时无法加载"
}

function useNarrowWorkspace() {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia("(max-width: 1023px)")
    const update = () => setIsNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return isNarrow
}

interface FilterControlsProps {
  idPrefix: string
  cityDraft: string
  city: string
  seriesCode: string
  openOnly: boolean
  series: FudabaSeries[]
  seriesMap: ReadonlyMap<string, FudabaSeries>
  hasFilters: boolean
  className?: string
  onCityDraftChange: (value: string) => void
  onCitySubmit: (event: FormEvent<HTMLFormElement>) => void
  onFilterChange: (name: string, value: string | null) => void
  onReset: () => void
}

function FilterControls({
  idPrefix,
  cityDraft,
  city,
  seriesCode,
  openOnly,
  series,
  seriesMap,
  hasFilters,
  className,
  onCityDraftChange,
  onCitySubmit,
  onFilterChange,
  onReset,
}: FilterControlsProps) {
  const cityInputId = `${idPrefix}-exchange-city`
  const seriesInputId = `${idPrefix}-exchange-series`

  return (
    <form
      className={cn(
        "grid min-w-0 gap-3 lg:grid-cols-[minmax(10rem,1fr)_minmax(10rem,0.8fr)_auto] lg:items-end",
        className
      )}
      onSubmit={onCitySubmit}
    >
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={cityInputId} className="text-xs">
          城市
        </Label>
        <div className="flex min-w-0 gap-1.5">
          <Input
            id={cityInputId}
            value={cityDraft}
            maxLength={100}
            placeholder="例如：上海"
            className="bg-background"
            onChange={(event) => onCityDraftChange(event.currentTarget.value)}
          />
          <Button type="submit" variant="outline" aria-label="按城市查找">
            <SearchIcon aria-hidden="true" />
            <span className="hidden sm:inline">查找</span>
          </Button>
        </div>
      </div>

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={seriesInputId} className="text-xs">
          企划
        </Label>
        <Select
          value={seriesCode || "all"}
          onValueChange={(value) =>
            onFilterChange(
              "series",
              String(value) === "all" ? null : String(value)
            )
          }
        >
          <SelectTrigger id={seriesInputId} className="w-full bg-background">
            <SelectValue>
              {seriesCode
                ? (seriesMap.get(seriesCode)?.displayName ?? seriesCode)
                : "全部企划"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectItem value="all">全部企划</SelectItem>
              {series.map((item) => (
                <SelectItem key={item.code} value={item.code}>
                  {item.displayName}（{item.activeOfficeCount}）
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <Label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={openOnly}
            onCheckedChange={(checked) =>
              onFilterChange("open", checked ? "true" : null)
            }
          />
          仅看开放事务所
        </Label>
        {hasFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            <XIcon aria-hidden="true" />
            清除筛选
          </Button>
        ) : null}
      </div>
      <output className="sr-only" aria-live="polite">
        {city ? `当前城市筛选：${city}` : "未筛选城市"}
      </output>
    </form>
  )
}

interface DirectoryResultsProps {
  view: DirectoryView
  state: DiscoveryState
  seriesMap: ReadonlyMap<string, FudabaSeries>
  hasFilters: boolean
  loadingMoreOffices: boolean
  loadingMoreCards: boolean
  onViewChange: (view: DirectoryView) => void
  onResetFilters: () => void
  onLoadMoreOffices: () => void
  onLoadMoreCards: () => void
}

function DirectoryResults({
  view,
  state,
  seriesMap,
  hasFilters,
  loadingMoreOffices,
  loadingMoreCards,
  onViewChange,
  onResetFilters,
  onLoadMoreOffices,
  onLoadMoreCards,
}: DirectoryResultsProps) {
  return (
    <Tabs
      value={view}
      onValueChange={(value) => onViewChange(value as DirectoryView)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="border-b px-4 pb-3">
        <TabsList className="w-full" aria-label="公开名录类型">
          <TabsTrigger value="offices">
            <Building2Icon aria-hidden="true" />
            事务所
          </TabsTrigger>
          <TabsTrigger value="cards">
            <CreditCardIcon aria-hidden="true" />
            名片
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="offices"
        className="min-h-0 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold">公开事务所</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasFilters ? "当前筛选结果" : "按访问热度排列"}
          </p>
        </div>
        {state.error ? (
          <Alert className="mb-4">
            <RefreshCwIcon aria-hidden="true" />
            <AlertTitle>部分内容未能继续加载</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {state.offices.length ? (
          <div className="space-y-3">
            {state.offices.map((office) => (
              <OfficeCard key={office.id} office={office} series={seriesMap} />
            ))}
            {state.officePageInfo.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loadingMoreOffices}
                onClick={onLoadMoreOffices}
              >
                {loadingMoreOffices ? (
                  <LoaderCircleIcon
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {loadingMoreOffices ? "正在加载" : "加载更多事务所"}
              </Button>
            ) : null}
          </div>
        ) : (
          <Empty className="min-h-56 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Building2Icon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>没有符合条件的事务所</EmptyTitle>
              <EmptyDescription>
                调整城市、企划或开放状态后重试。
              </EmptyDescription>
            </EmptyHeader>
            {hasFilters ? (
              <Button type="button" variant="outline" onClick={onResetFilters}>
                清除筛选
              </Button>
            ) : null}
          </Empty>
        )}
      </TabsContent>

      <TabsContent
        value="cards"
        className="min-h-0 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold">可交换名片</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {state.cards.length} 张已公开名片
          </p>
        </div>
        {state.error ? (
          <Alert className="mb-4">
            <RefreshCwIcon aria-hidden="true" />
            <AlertTitle>部分内容未能继续加载</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {state.cards.length ? (
          <div className="space-y-3">
            {state.cards.map((card) => (
              <ExchangeCard key={card.id} card={card} series={seriesMap} />
            ))}
            {state.cardPageInfo.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loadingMoreCards}
                onClick={onLoadMoreCards}
              >
                {loadingMoreCards ? (
                  <LoaderCircleIcon
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {loadingMoreCards ? "正在加载" : "加载更多名片"}
              </Button>
            ) : null}
          </div>
        ) : (
          <Empty className="min-h-56 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CreditCardIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>当前没有可交换名片</EmptyTitle>
              <EmptyDescription>
                已审核且开放交换的名片会显示在这里。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
    </Tabs>
  )
}

export function meta() {
  return [
    { title: "名片交换事务所 | IMSWeb" },
    {
      name: "description",
      content: "按城市和企划浏览制作人名片交换事务所。",
    },
  ]
}

export default function CommunityExchangePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const city = searchParams.get("city")?.trim() ?? ""
  const seriesCode = searchParams.get("series")?.trim() ?? ""
  const openOnly = searchParams.get("open") === "true"
  const [cityDraft, setCityDraft] = useState(city)
  const [state, setState] = useState<DiscoveryState>(initialState)
  const [refreshing, setRefreshing] = useState(true)
  const [loadingMoreOffices, setLoadingMoreOffices] = useState(false)
  const [loadingMoreCards, setLoadingMoreCards] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [directoryView, setDirectoryView] = useState<DirectoryView>("offices")
  const requestGeneration = useRef(0)
  const officeRequestInFlight = useRef<symbol | null>(null)
  const cardRequestInFlight = useRef<symbol | null>(null)
  const isNarrow = useNarrowWorkspace()

  const loadFirstPage = useCallback(async () => {
    const generation = ++requestGeneration.current
    officeRequestInFlight.current = null
    cardRequestInFlight.current = null
    setState((current) =>
      current.phase === "ready"
        ? { ...current, error: null }
        : { ...current, phase: "loading", error: null }
    )
    setRefreshing(true)
    setLoadingMoreOffices(false)
    setLoadingMoreCards(false)

    try {
      const [seriesResult, officeResult, cardResult] = await Promise.all([
        getFudabaSeries().send(),
        getFudabaOfficePage({
          city: city || undefined,
          series: seriesCode || undefined,
          open: openOnly ? true : undefined,
          limit: 12,
        }).send(),
        getFudabaCardPage({
          series: seriesCode || undefined,
          available: true,
          limit: 8,
        }).send(),
      ])
      if (requestGeneration.current !== generation) return
      setState({
        phase: "ready",
        series: seriesResult.items,
        offices: officeResult.items,
        officePageInfo: officeResult.pageInfo,
        cards: cardResult.items,
        cardPageInfo: cardResult.pageInfo,
        error: null,
      })
    } catch (error) {
      if (requestGeneration.current !== generation) return
      const closed =
        isApiError(error) &&
        error.status === 404 &&
        error.payload === "Not Found"
      setState((current) =>
        current.phase === "ready" && !closed
          ? { ...current, error: discoveryErrorMessage(error) }
          : {
              ...current,
              phase: closed ? "closed" : "error",
              error: discoveryErrorMessage(error),
            }
      )
    } finally {
      if (requestGeneration.current === generation) setRefreshing(false)
    }
  }, [city, openOnly, seriesCode])

  useEffect(() => {
    setCityDraft(city)
  }, [city])

  useEffect(() => {
    if (!searchParams.has("bbox") && !searchParams.has("view")) return
    const next = new URLSearchParams(searchParams)
    next.delete("bbox")
    next.delete("view")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    void loadFirstPage()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadFirstPage])

  const seriesMap = useMemo(
    () => new Map(state.series.map((item) => [item.code, item])),
    [state.series]
  )

  function updateFilter(name: string, value: string | null) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(name, value)
    else next.delete(name)
    setSearchParams(next, { replace: true })
  }

  function applyCityFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    updateFilter("city", cityDraft.trim() || null)
    setFilterOpen(false)
  }

  function resetFilters() {
    setCityDraft("")
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  function openDirectory(view: DirectoryView) {
    setDirectoryView(view)
    setDirectoryOpen(true)
  }

  const loadMoreOffices = useCallback(async () => {
    if (
      officeRequestInFlight.current ||
      !state.officePageInfo.hasNextPage ||
      !state.officePageInfo.nextCursor
    ) {
      return
    }
    const generation = requestGeneration.current
    const requestToken = Symbol("fudaba-office-page")
    officeRequestInFlight.current = requestToken
    setLoadingMoreOffices(true)
    setState((current) => ({ ...current, error: null }))
    try {
      const result = await getFudabaOfficePage({
        city: city || undefined,
        series: seriesCode || undefined,
        open: openOnly ? true : undefined,
        cursor: state.officePageInfo.nextCursor,
        limit: 12,
      }).send()
      if (requestGeneration.current !== generation) return
      setState((current) => ({
        ...current,
        offices: deduplicateById(current.offices, result.items),
        officePageInfo: result.pageInfo,
      }))
    } catch (error) {
      if (requestGeneration.current !== generation) return
      setState((current) => ({
        ...current,
        error: `更多事务所加载失败：${discoveryErrorMessage(error)}`,
      }))
    } finally {
      if (officeRequestInFlight.current === requestToken) {
        officeRequestInFlight.current = null
        setLoadingMoreOffices(false)
      }
    }
  }, [city, openOnly, seriesCode, state.officePageInfo])

  const loadMoreCards = useCallback(async () => {
    if (
      cardRequestInFlight.current ||
      !state.cardPageInfo.hasNextPage ||
      !state.cardPageInfo.nextCursor
    ) {
      return
    }
    const generation = requestGeneration.current
    const requestToken = Symbol("fudaba-card-page")
    cardRequestInFlight.current = requestToken
    setLoadingMoreCards(true)
    setState((current) => ({ ...current, error: null }))
    try {
      const result = await getFudabaCardPage({
        series: seriesCode || undefined,
        available: true,
        cursor: state.cardPageInfo.nextCursor,
        limit: 8,
      }).send()
      if (requestGeneration.current !== generation) return
      setState((current) => ({
        ...current,
        cards: deduplicateById(current.cards, result.items),
        cardPageInfo: result.pageInfo,
      }))
    } catch (error) {
      if (requestGeneration.current !== generation) return
      setState((current) => ({
        ...current,
        error: `更多名片加载失败：${discoveryErrorMessage(error)}`,
      }))
    } finally {
      if (cardRequestInFlight.current === requestToken) {
        cardRequestInFlight.current = null
        setLoadingMoreCards(false)
      }
    }
  }, [seriesCode, state.cardPageInfo])

  const hasFilters = Boolean(city || seriesCode || openOnly)
  const filterProps = {
    cityDraft,
    city,
    seriesCode,
    openOnly,
    series: state.series,
    seriesMap,
    hasFilters,
    onCityDraftChange: setCityDraft,
    onCitySubmit: applyCityFilter,
    onFilterChange: updateFilter,
    onReset: resetFilters,
  }

  return (
    <main
      id="main-content"
      className="relative size-full min-h-0 overflow-hidden bg-[#e8f2f4]"
    >
      {state.phase === "ready" ? (
        <>
          <div className="flex size-full min-h-0">
            <ExchangeDiscoveryRail
              cityDraft={cityDraft}
              seriesCode={seriesCode}
              openOnly={openOnly}
              series={state.series}
              offices={state.offices}
              cardCount={state.cards.length}
              refreshing={refreshing}
              error={state.error}
              hasFilters={hasFilters}
              onCityDraftChange={setCityDraft}
              onCitySubmit={applyCityFilter}
              onSeriesChange={(value) => updateFilter("series", value)}
              onOpenChange={(value) =>
                updateFilter("open", value ? "true" : null)
              }
              onResetFilters={resetFilters}
              onRefresh={() => void loadFirstPage()}
              onOpenOffices={() => openDirectory("offices")}
              onOpenCards={() => openDirectory("cards")}
            />

            <div className="relative min-w-0 flex-1">
              <CommunityExchangeMapSection
                city={city || undefined}
                series={seriesCode || undefined}
                seriesCatalog={state.series}
                open={openOnly ? true : undefined}
                onSwitchDirectory={() => openDirectory("offices")}
              />

              <section
                className="pointer-events-none absolute inset-x-3 top-3 z-20 lg:hidden"
                aria-label="地图工具"
              >
                <div className="pointer-events-auto relative overflow-hidden rounded-lg border bg-background/95 shadow-md backdrop-blur-sm">
                  <SeriesAccentStrip className="absolute inset-x-0 top-0 h-1" />
                  <div className="flex min-w-0 items-center gap-2 px-3 pt-3 pb-2">
                    <MapPinnedIcon
                      className="size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h1 className="truncate text-sm font-semibold sm:text-base">
                        名片交换事务所
                      </h1>
                      <p className="hidden truncate text-xs text-muted-foreground sm:block">
                        {state.offices.length} 个事务所 · {state.cards.length}{" "}
                        张名片
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="刷新交换区"
                        title="刷新"
                        disabled={refreshing}
                        onClick={() => void loadFirstPage()}
                      >
                        <RefreshCwIcon
                          className={cn(
                            refreshing &&
                              "animate-spin motion-reduce:animate-none"
                          )}
                          aria-hidden="true"
                        />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="打开筛选"
                        title="筛选"
                        onClick={() => setFilterOpen(true)}
                      >
                        <ListFilterIcon aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="打开事务所名录"
                        title="事务所名录"
                        onClick={() => openDirectory("offices")}
                      >
                        <Building2Icon aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="打开名片名录"
                        title="名片名录"
                        onClick={() => openDirectory("cards")}
                      >
                        <CreditCardIcon aria-hidden="true" />
                      </Button>
                      <Link
                        to="/community/exchange/me"
                        className={buttonVariants({
                          variant: "outline",
                          size: "icon",
                        })}
                        aria-label="管理我的交换账号"
                        title="账号管理"
                      >
                        <UserRoundCogIcon aria-hidden="true" />
                      </Link>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
            <SheetContent
              side="bottom"
              className="max-h-[82dvh] overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
            >
              <SheetHeader className="border-b pr-14">
                <SheetTitle>筛选地图</SheetTitle>
                <SheetDescription>
                  按城市、企划与开放状态收窄地图和名录。
                </SheetDescription>
              </SheetHeader>
              <FilterControls
                {...filterProps}
                idPrefix="mobile"
                className="px-4"
              />
            </SheetContent>
          </Sheet>

          <Sheet open={directoryOpen} onOpenChange={setDirectoryOpen}>
            <SheetContent
              side={isNarrow ? "bottom" : "right"}
              className={cn(
                "min-h-0 gap-0 overflow-hidden",
                isNarrow
                  ? "max-h-[86dvh]"
                  : "h-dvh w-[min(92vw,30rem)] sm:max-w-120"
              )}
            >
              <SheetHeader className="shrink-0 pr-14">
                <SheetTitle>公开交换名录</SheetTitle>
                <SheetDescription>
                  地图范围之外的公开事务所和名片也会保留在这里。
                </SheetDescription>
              </SheetHeader>
              <DirectoryResults
                view={directoryView}
                state={state}
                seriesMap={seriesMap}
                hasFilters={hasFilters}
                loadingMoreOffices={loadingMoreOffices}
                loadingMoreCards={loadingMoreCards}
                onViewChange={setDirectoryView}
                onResetFilters={resetFilters}
                onLoadMoreOffices={() => void loadMoreOffices()}
                onLoadMoreCards={() => void loadMoreCards()}
              />
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <section className="relative flex size-full min-h-0 items-center justify-center overflow-hidden px-4">
          <SeriesAccentStrip className="absolute inset-x-0 top-0 h-1" />
          {state.phase === "loading" ? (
            <div
              aria-label="正在加载交换区"
              className="w-full max-w-sm rounded-lg border bg-background/95 p-5 shadow-sm"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
              <p className="sr-only">正在加载名片交换事务所地图</p>
            </div>
          ) : state.phase === "closed" ? (
            <Empty className="w-full max-w-lg rounded-lg border bg-background/95 px-5 shadow-sm">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MapPinnedIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>社区交换区尚未开放</EmptyTitle>
                <EmptyDescription>
                  事务所与名片完成公开审核后会在这里显示。
                </EmptyDescription>
              </EmptyHeader>
              <Link
                to="/community"
                className={buttonVariants({ variant: "outline" })}
              >
                返回制作人社区
              </Link>
            </Empty>
          ) : (
            <Alert
              variant="destructive"
              className="w-full max-w-lg bg-background/95 shadow-sm"
            >
              <SlidersHorizontalIcon aria-hidden="true" />
              <AlertTitle>社区交换区暂时无法加载</AlertTitle>
              <AlertDescription>
                {state.error || "请稍后重新加载。"}
              </AlertDescription>
              <div className="col-start-2 mt-3">
                <Button type="button" onClick={() => void loadFirstPage()}>
                  <RefreshCwIcon aria-hidden="true" />
                  重新加载
                </Button>
              </div>
            </Alert>
          )}
        </section>
      )}
    </main>
  )
}
