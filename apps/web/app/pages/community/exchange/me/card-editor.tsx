import {
  CircleAlertIcon,
  FileImageIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import {
  createFudabaCard,
  deleteFudabaCard,
  updateFudabaCard,
  uploadFudabaCardMedia,
  type FudabaCardFields,
  type FudabaCardMediaSide,
  type FudabaOwnerCard,
  type FudabaSeries,
  type PlatformProfile,
} from "~/lib/api"
import { CardDeleteDialog } from "./card-delete-dialog"
import {
  CardFields,
  CardImageFields,
  CardPreview,
  useObjectUrl,
} from "./card-editor-fields"
import { PublicationBadge, RightsBadge } from "./card-inventory"
import {
  apiMessage,
  cardFields,
  emptyCardFields,
  isCardConflict,
  isFeatureClosed,
  validateImage,
  type EditorFeedback,
} from "./exchange-me-model"

const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024

export function CardEditor({
  card,
  creating,
  profile,
  series,
  readOnly,
  readOnlyReason,
  onCreated,
  onSaved,
  onDeleted,
  onReload,
  onWriteClosed,
}: {
  card: FudabaOwnerCard | null
  creating: boolean
  profile: PlatformProfile
  series: FudabaSeries[]
  readOnly: boolean
  readOnlyReason: string | null
  onCreated: (card: FudabaOwnerCard) => void
  onSaved: (card: FudabaOwnerCard) => void
  onDeleted: (cardId: string) => void
  onReload: (cardId: string) => Promise<FudabaOwnerCard>
  onWriteClosed: () => void
}) {
  const [draft, setDraft] = useState<FudabaCardFields>(() =>
    card ? cardFields(card) : emptyCardFields(profile, series)
  )
  const [frontFile, setFrontFile] = useState<File | null>(null)
  const [backFile, setBackFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploadingSide, setUploadingSide] =
    useState<FudabaCardMediaSide | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [feedback, setFeedback] = useState<EditorFeedback | null>(null)
  const frontObjectUrl = useObjectUrl(frontFile)
  const backObjectUrl = useObjectUrl(backFile)

  function selectImage(file: File | null, side: FudabaCardMediaSide) {
    if (!file) {
      if (side === "front") setFrontFile(null)
      else setBackFile(null)
      return
    }
    const invalid = validateImage(file, MAX_CARD_IMAGE_BYTES)
    if (invalid) {
      setFeedback({ kind: "error", message: invalid })
      return
    }
    setFeedback(null)
    if (side === "front") setFrontFile(file)
    else setBackFile(file)
  }

  function mutationFailure(error: unknown, fallback: string) {
    if (isCardConflict(error)) {
      setFeedback({
        kind: "conflict",
        message:
          "名片已在其他窗口更新。当前输入仍保留，请载入最新版本后再继续。",
      })
      return
    }
    if (isFeatureClosed(error)) {
      onWriteClosed()
      setFeedback({ kind: "error", message: "名片编辑当前未开放。" })
      return
    }
    setFeedback({ kind: "error", message: apiMessage(error, fallback) })
  }

  async function createCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!frontFile || !backFile) {
      setFeedback({
        kind: "error",
        message: "请分别选择名片正面和背面图片。",
      })
      return
    }
    setSaving(true)
    setFeedback(null)
    try {
      const result = await createFudabaCard({
        ...draft,
        front: frontFile,
        back: backFile,
      }).send()
      setDraft(cardFields(result.card))
      onCreated(result.card)
      setFrontFile(null)
      setBackFile(null)
      setFeedback({ kind: "success", message: "名片草稿已创建。" })
      toast.success("名片草稿已创建")
    } catch (error) {
      mutationFailure(error, "名片创建失败，请检查内容和图片后重试。")
    } finally {
      setSaving(false)
    }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!card) return
    setSaving(true)
    setFeedback(null)
    try {
      const result = await updateFudabaCard(card.id, {
        ...draft,
        expectedRevision: card.revision,
      }).send()
      setDraft(cardFields(result.card))
      onSaved(result.card)
      setFeedback({ kind: "success", message: "名片资料已保存。" })
      toast.success("名片资料已保存")
    } catch (error) {
      mutationFailure(error, "名片资料保存失败，请重试。")
    } finally {
      setSaving(false)
    }
  }

  async function uploadSide(side: FudabaCardMediaSide) {
    if (!card) return
    const file = side === "front" ? frontFile : backFile
    if (!file) return
    setUploadingSide(side)
    setFeedback(null)
    try {
      const result = await uploadFudabaCardMedia(
        card.id,
        side,
        file,
        card.revision
      ).send()
      setDraft(cardFields(result.card))
      onSaved(result.card)
      if (side === "front") setFrontFile(null)
      else setBackFile(null)
      const label = side === "front" ? "正面" : "背面"
      setFeedback({ kind: "success", message: `名片${label}已更新。` })
      toast.success(`名片${label}已更新`)
    } catch (error) {
      mutationFailure(error, "名片图片上传失败，请重试。")
    } finally {
      setUploadingSide(null)
    }
  }

  async function removeCard() {
    if (!card) return
    setDeleting(true)
    setFeedback(null)
    try {
      await deleteFudabaCard(card.id, card.revision).send()
      setDeleteOpen(false)
      onDeleted(card.id)
      toast.success("名片已删除")
    } catch (error) {
      setDeleteOpen(false)
      mutationFailure(error, "名片删除失败，请重试。")
    } finally {
      setDeleting(false)
    }
  }

  async function reloadLatest() {
    if (!card) return
    try {
      const latest = await onReload(card.id)
      setDraft(cardFields(latest))
      setFeedback({ kind: "success", message: "已载入最新名片版本。" })
    } catch (error) {
      setFeedback({
        kind: "error",
        message: apiMessage(error, "最新名片载入失败，请重试。"),
      })
    }
  }

  const busy = saving || uploadingSide !== null || deleting
  const editDisabled = readOnly || busy
  const previewFront = frontObjectUrl ?? card?.frontImageUrl ?? null
  const previewBack = backObjectUrl ?? card?.backImageUrl ?? null

  if (creating && readOnly && !card) {
    return (
      <Empty className="min-h-80 border-y">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileImageIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>名片编辑暂未开放</EmptyTitle>
          <EmptyDescription>
            {readOnlyReason || "当前帐号只能查看已有内容。"}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <section className="min-w-0" aria-labelledby="owned-card-editor-title">
      <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="owned-card-editor-title" className="text-base font-medium">
            {creating ? "新建名片" : "编辑名片"}
          </h2>
          <p className="mt-1 text-sm wrap-break-word text-muted-foreground">
            {creating
              ? "名片创建后保持草稿状态，素材授权与公开状态由审核流程更新。"
              : `版本 ${card?.revision ?? 0} · ${card?.updatedAt ? new Date(card.updatedAt).toLocaleString("zh-CN") : ""}`}
          </p>
        </div>
        {!creating && card ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <PublicationBadge card={card} />
            <RightsBadge card={card} />
          </div>
        ) : (
          <Badge variant="outline">新草稿</Badge>
        )}
      </div>

      {readOnlyReason ? (
        <Alert className="mt-4">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>名片暂时只读</AlertTitle>
          <AlertDescription>{readOnlyReason}</AlertDescription>
        </Alert>
      ) : null}

      {feedback ? (
        <Alert
          className="mt-4"
          variant={feedback.kind === "error" ? "destructive" : "default"}
        >
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>
            {feedback.kind === "success"
              ? "操作成功"
              : feedback.kind === "conflict"
                ? "名片版本冲突"
                : "操作未完成"}
          </AlertTitle>
          <AlertDescription>
            <p>{feedback.message}</p>
            {feedback.kind === "conflict" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void reloadLatest()}
              >
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                载入最新名片
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-5">
        <CardPreview
          frontUrl={previewFront}
          backUrl={previewBack}
          displayName={draft.displayName}
        />
      </div>

      <form
        className="mt-6"
        onSubmit={(event) =>
          void (creating ? createCard(event) : saveMetadata(event))
        }
      >
        <CardFields
          draft={draft}
          series={series}
          disabled={editDisabled}
          onChange={setDraft}
        />

        {creating ? (
          <div className="mt-6">
            <CardImageFields
              mode="create"
              frontFile={frontFile}
              backFile={backFile}
              disabled={editDisabled}
              saving={saving}
              uploadingSide={uploadingSide}
              onSelect={selectImage}
            />
          </div>
        ) : null}

        <div className="mt-6 flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="submit"
            disabled={
              editDisabled ||
              !draft.producerName.trim() ||
              !draft.displayName.trim() ||
              !draft.seriesCode ||
              (creating && (!frontFile || !backFile))
            }
          >
            {saving ? (
              <LoaderCircleIcon
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : creating ? (
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
            ) : (
              <SaveIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {saving ? "正在保存" : creating ? "创建名片草稿" : "保存名片资料"}
          </Button>
          {!creating && card ? (
            <Button
              type="button"
              variant="destructive"
              disabled={editDisabled}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              删除名片
            </Button>
          ) : null}
        </div>
      </form>

      {!creating && card ? (
        <section
          className="mt-8 border-t pt-6"
          aria-labelledby="card-media-title"
        >
          <h3 id="card-media-title" className="text-sm font-medium">
            替换名片图片
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            正面和背面分别保存，每次上传都会生成新的名片版本。
          </p>
          <div className="mt-5">
            <CardImageFields
              mode="replace"
              frontFile={frontFile}
              backFile={backFile}
              disabled={editDisabled}
              saving={saving}
              uploadingSide={uploadingSide}
              onSelect={selectImage}
              onUpload={(side) => void uploadSide(side)}
            />
          </div>
        </section>
      ) : null}

      <CardDeleteDialog
        open={deleteOpen}
        deleting={deleting}
        displayName={card?.displayName ?? "当前名片"}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void removeCard()}
      />
    </section>
  )
}
