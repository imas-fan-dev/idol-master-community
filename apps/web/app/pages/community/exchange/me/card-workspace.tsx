import { FileImageIcon } from "lucide-react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { Skeleton } from "~/components/ui/skeleton"
import type { FudabaOwnerCard, FudabaSeries, PlatformProfile } from "~/lib/api"
import { CardEditor } from "./card-editor"
import { CardInventory } from "./card-inventory"

export function CardWorkspace({
  cards,
  selectedCardId,
  creating,
  loadingDetail,
  profile,
  series,
  readOnly,
  readOnlyReason,
  onSelect,
  onCreate,
  onCreated,
  onSaved,
  onDeleted,
  onReload,
  onWriteClosed,
}: {
  cards: FudabaOwnerCard[]
  selectedCardId: string | null
  creating: boolean
  loadingDetail: boolean
  profile: PlatformProfile
  series: FudabaSeries[]
  readOnly: boolean
  readOnlyReason: string | null
  onSelect: (cardId: string) => void
  onCreate: () => void
  onCreated: (card: FudabaOwnerCard) => void
  onSaved: (card: FudabaOwnerCard) => void
  onDeleted: (cardId: string) => void
  onReload: (cardId: string) => Promise<FudabaOwnerCard>
  onWriteClosed: () => void
}) {
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null

  return (
    <div className="grid min-w-0 gap-8 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <CardInventory
        cards={cards}
        selectedCardId={creating ? null : selectedCardId}
        readOnly={readOnly}
        onSelect={onSelect}
        onCreate={onCreate}
      />
      <div className="min-w-0">
        {loadingDetail ? (
          <div aria-label="正在载入名片" className="flex flex-col gap-4">
            <Skeleton className="h-10 w-48" />
            <Skeleton className="aspect-3/2 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : selectedCard || creating ? (
          <CardEditor
            key={creating ? "new" : selectedCard?.id}
            card={selectedCard}
            creating={creating}
            profile={profile}
            series={series}
            readOnly={readOnly}
            readOnlyReason={readOnlyReason}
            onCreated={onCreated}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onReload={onReload}
            onWriteClosed={onWriteClosed}
          />
        ) : (
          <Empty className="min-h-80 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileImageIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>选择一张名片</EmptyTitle>
              <EmptyDescription>
                从清单选择名片以查看正反面和编辑资料。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  )
}
