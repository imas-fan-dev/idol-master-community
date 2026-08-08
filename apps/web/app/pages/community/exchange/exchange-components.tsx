import {
  BookmarkIcon,
  Building2Icon,
  EyeIcon,
  HeartIcon,
  MapPinIcon,
} from "lucide-react"
import { Link } from "react-router"

import { CoverImagePreview } from "~/components/shared/cover-image-preview"
import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import { Badge } from "~/components/ui/badge"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import type { FudabaCard, FudabaOffice, FudabaSeries } from "~/lib/api"
import { cn } from "~/lib/utils"

export { PlacedCardWall } from "./exchange-card-wall"

export function SeriesBadge({
  code,
  series,
}: {
  code: string
  series: ReadonlyMap<string, FudabaSeries>
}) {
  const catalogSeries = series.get(code)
  return (
    <Badge
      variant="outline"
      className={cn("max-w-full", !catalogSeries && "bg-muted")}
      style={
        catalogSeries
          ? {
              borderColor: catalogSeries.color,
              backgroundColor: `color-mix(in srgb, ${catalogSeries.color} 12%, transparent)`,
            }
          : undefined
      }
    >
      <span className="truncate">{catalogSeries?.displayName ?? code}</span>
    </Badge>
  )
}

export function OfficeCard({
  office,
  series,
}: {
  office: FudabaOffice
  series: ReadonlyMap<string, FudabaSeries>
}) {
  return (
    <Card
      className="group relative h-full overflow-hidden border-t-2 transition-colors hover:border-foreground/25"
      style={{ borderTopColor: office.accent }}
    >
      {office.coverUrl ? (
        <div className="aspect-16/7 overflow-hidden border-b bg-muted">
          <img
            src={office.coverUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
          />
        </div>
      ) : (
        <div className="relative flex aspect-16/7 items-center justify-center overflow-hidden border-b bg-muted/60">
          <SeriesAccentStrip className="absolute inset-x-0 top-0 h-1" />
          <Building2Icon
            className="size-8 text-muted-foreground/70"
            aria-hidden="true"
          />
        </div>
      )}
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <CardTitle className="min-w-0 truncate text-base">
            <Link
              to={`/community/exchange/offices/${encodeURIComponent(office.slug)}`}
              className="rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {office.name}
            </Link>
          </CardTitle>
          <Badge
            variant="secondary"
            className={cn(
              office.isOpen
                ? "bg-success/20 text-success-foreground"
                : "text-muted-foreground"
            )}
          >
            {office.isOpen ? "开放交换" : "暂未开放"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MapPinIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{office.city}</span>
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            aria-label={`${office.visitorCount.toLocaleString("zh-CN")} 次访问`}
          >
            <EyeIcon className="size-3.5" aria-hidden="true" />
            {office.visitorCount.toLocaleString("zh-CN")}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="line-clamp-2 text-sm/6 text-muted-foreground">
          {office.intro || "事务所暂未填写介绍。"}
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-1.5">
        {office.seriesCodes.map((code) => (
          <SeriesBadge key={code} code={code} series={series} />
        ))}
      </CardFooter>
    </Card>
  )
}

function CardMediaPair({ card }: { card: FudabaCard }) {
  return (
    <div className="grid grid-cols-2 gap-px border-b bg-border">
      <CoverImagePreview
        src={card.frontImageUrl}
        alt={`${card.displayName}正面`}
        previewLabel="名片"
        className="aspect-3/2 rounded-none bg-muted"
        imageClassName="object-contain"
      />
      <CoverImagePreview
        src={card.backImageUrl}
        alt={`${card.displayName}背面`}
        previewLabel="名片"
        className="aspect-3/2 rounded-none bg-muted"
        imageClassName="object-contain"
      />
    </div>
  )
}

export function ExchangeCard({
  card,
  series,
}: {
  card: FudabaCard
  series: ReadonlyMap<string, FudabaSeries>
}) {
  return (
    <Card
      className="h-full overflow-hidden border-t-2"
      style={{ borderTopColor: card.accent }}
    >
      <CardMediaPair card={card} />
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="min-w-0 truncate text-sm">
            {card.displayName}
          </CardTitle>
          <Badge variant={card.available ? "default" : "secondary"}>
            {card.available ? "可交换" : "仅展示"}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {card.producerName}
          {card.favoriteIdol ? ` · ${card.favoriteIdol}` : ""}
        </p>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="line-clamp-2 text-sm/6 text-muted-foreground">
          {card.tradeNote || card.bio || "暂未填写交换说明。"}
        </p>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-3">
        <SeriesBadge code={card.seriesCode} series={series} />
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <span
            className="inline-flex items-center gap-1"
            aria-label={`${card.interactions.likes} 次点赞`}
          >
            <HeartIcon
              className={cn(
                "size-3.5",
                card.interactions.viewerLiked && "fill-current"
              )}
              aria-hidden="true"
            />
            {card.interactions.likes}
          </span>
          <span
            className="inline-flex items-center gap-1"
            aria-label={`${card.interactions.favorites} 次收藏`}
          >
            <BookmarkIcon
              className={cn(
                "size-3.5",
                card.interactions.viewerFavorited && "fill-current"
              )}
              aria-hidden="true"
            />
            {card.interactions.favorites}
          </span>
        </span>
      </CardFooter>
    </Card>
  )
}
