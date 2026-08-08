import { FileImageIcon, PlusIcon } from "lucide-react"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import type { FudabaOwnerCard } from "~/lib/api"
import { cn } from "~/lib/utils"
import { mediaRightsLabels, publicationLabels } from "./exchange-me-model"

export function PublicationBadge({ card }: { card: FudabaOwnerCard }) {
  const status = card.publicationStatus
  return (
    <Badge
      variant={status === "rejected" ? "destructive" : "secondary"}
      className={cn(
        status === "published" && "bg-success/20 text-success-foreground",
        status === "pending" && "bg-pending/20 text-pending-foreground"
      )}
    >
      {publicationLabels[status]}
    </Badge>
  )
}

export function RightsBadge({ card }: { card: FudabaOwnerCard }) {
  const status = card.mediaRightsStatus
  return (
    <Badge
      variant={status === "denied" ? "destructive" : "outline"}
      className={cn(
        status === "approved" && "bg-success/20 text-success-foreground",
        status === "unknown" && "bg-warning/20 text-warning-foreground"
      )}
    >
      {mediaRightsLabels[status]}
    </Badge>
  )
}

export function CardInventory({
  cards,
  selectedCardId,
  readOnly,
  onSelect,
  onCreate,
}: {
  cards: FudabaOwnerCard[]
  selectedCardId: string | null
  readOnly: boolean
  onSelect: (cardId: string) => void
  onCreate: () => void
}) {
  return (
    <section aria-labelledby="owned-card-list-title">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="owned-card-list-title" className="text-base font-medium">
            我的名片
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {cards.length} 张名片
          </p>
        </div>
        <Button type="button" size="sm" disabled={readOnly} onClick={onCreate}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          新建名片
        </Button>
      </div>

      {cards.length ? (
        <nav
          className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-1"
          aria-label="我的名片清单"
        >
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className={cn(
                "grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] gap-3 rounded-lg border bg-background p-2 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                selectedCardId === card.id && "border-primary bg-accent/40"
              )}
              aria-current={selectedCardId === card.id ? "page" : undefined}
              onClick={() => onSelect(card.id)}
            >
              <span className="aspect-3/2 overflow-hidden rounded-md border bg-muted">
                <img
                  src={card.frontImageUrl}
                  alt=""
                  className="size-full object-contain"
                />
              </span>
              <span className="min-w-0 self-center">
                <span className="block truncate text-sm font-medium">
                  {card.displayName}
                </span>
                <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                  <PublicationBadge card={card} />
                  <Badge variant={card.available ? "default" : "outline"}>
                    {card.available ? "可交换" : "仅展示"}
                  </Badge>
                </span>
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <Empty className="mt-4 min-h-44 border-y">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileImageIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>还没有交换名片</EmptyTitle>
            <EmptyDescription>
              {readOnly
                ? "名片创建开放后，可以在这里建立双面名片。"
                : "建立第一张双面名片，保存后会先进入草稿状态。"}
            </EmptyDescription>
          </EmptyHeader>
          {!readOnly ? (
            <Button type="button" variant="outline" onClick={onCreate}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              新建名片
            </Button>
          ) : null}
        </Empty>
      )}
    </section>
  )
}
