import type { LucideIcon } from "lucide-react"
import { FileUpIcon, LoaderCircleIcon, UploadIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

function formatFileSize(bytes: number, language: string) {
  const formatInteger = new Intl.NumberFormat(language, {
    maximumFractionDigits: 0,
  })
  const formatDecimal = new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })

  if (bytes < 1024) return `${formatInteger.format(bytes)} B`
  if (bytes < 1024 * 1024) {
    return `${formatDecimal.format(bytes / 1024)} KiB`
  }
  return `${formatDecimal.format(bytes / 1024 / 1024)} MiB`
}

export type FileUploadControlProps = {
  id: string
  accept: string
  emptyTitle: string
  emptyDetail: string
  fileKind: string
  onSelect: (file: File | null) => void
  name?: string
  file?: File | null
  disabled?: boolean
  uploading?: boolean
  required?: boolean
  resetAfterSelect?: boolean
  invalid?: boolean
  invalidLabel?: string | null
  compact?: boolean
  dropZoneLabel?: string
  dropTitle?: string
  selectedIcon?: LucideIcon
  emptyIcon?: LucideIcon
}

export function FileUploadControl({
  id,
  name,
  accept,
  emptyTitle,
  emptyDetail,
  fileKind,
  file = null,
  disabled = false,
  uploading = false,
  required = false,
  resetAfterSelect = false,
  invalid = false,
  invalidLabel,
  compact = false,
  dropZoneLabel,
  dropTitle,
  selectedIcon: SelectedIcon = FileUpIcon,
  emptyIcon: EmptyIcon = UploadIcon,
  onSelect,
}: FileUploadControlProps) {
  const { i18n, t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const inactive = disabled || uploading
  const language = i18n.resolvedLanguage || i18n.language
  const resolvedDropZoneLabel =
    dropZoneLabel || t("upload.dropZoneLabel", { fileKind })
  const resolvedDropTitle = dropTitle || t("upload.dropTitle", { fileKind })

  useEffect(() => {
    if (!file && inputRef.current) inputRef.current.value = ""
  }, [file])

  function selectFile(selectedFile: File | null) {
    setDragging(false)
    onSelect(selectedFile)
    if (resetAfterSelect && inputRef.current) inputRef.current.value = ""
  }

  function clearFile() {
    if (inputRef.current) inputRef.current.value = ""
    selectFile(null)
  }

  const title = uploading
    ? t("upload.uploadingTitle", { fileKind })
    : dragging
      ? resolvedDropTitle
      : file?.name || emptyTitle
  const detail = uploading
    ? t("upload.uploadingDetail")
    : file
      ? t("upload.selectedDetail", {
          fileKind,
          size: formatFileSize(file.size, language),
        })
      : emptyDetail

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="file"
        accept={accept}
        className="peer sr-only w-px!"
        disabled={inactive}
        aria-busy={uploading}
        aria-required={required}
        aria-invalid={invalid}
        onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
      />
      <div
        role="group"
        aria-label={resolvedDropZoneLabel}
        className={cn(
          "flex min-w-0 flex-col justify-center rounded-lg border border-dashed bg-muted/25 transition-[border-color,background-color,box-shadow] peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/30 sm:flex-row sm:items-center",
          compact ? "min-h-0 gap-3 p-3" : "min-h-24 gap-4 p-4",
          dragging && "border-primary bg-accent/45 ring-3 ring-ring/20",
          invalid && "border-destructive/50 bg-destructive/5",
          inactive
            ? "cursor-not-allowed opacity-60"
            : "hover:border-primary/50 hover:bg-accent/35"
        )}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!inactive) setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!inactive) event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget
          if (
            nextTarget instanceof Node &&
            event.currentTarget.contains(nextTarget)
          ) {
            return
          }
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (inactive) return
          selectFile(event.dataTransfer.files?.[0] ?? null)
        }}
      >
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
            compact && "size-9",
            file && !invalid && "text-primary",
            invalid && "text-destructive"
          )}
        >
          {uploading ? (
            <LoaderCircleIcon
              className="size-5 animate-spin"
              aria-hidden="true"
            />
          ) : dragging ? (
            <UploadIcon className="size-5" aria-hidden="true" />
          ) : file ? (
            <SelectedIcon className="size-5" aria-hidden="true" />
          ) : (
            <EmptyIcon className="size-5" aria-hidden="true" />
          )}
        </span>

        <div className="min-w-0 flex-1" aria-live="polite">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={title}
            >
              {title}
            </p>
            {uploading ? (
              <Badge variant="secondary">{t("upload.uploadingStatus")}</Badge>
            ) : file ? (
              <Badge variant={invalid ? "destructive" : "secondary"}>
                {invalidLabel ||
                  t(
                    invalid
                      ? "upload.unavailableStatus"
                      : "upload.selectedStatus"
                  )}
              </Badge>
            ) : null}
          </div>
          <p
            className={cn(
              "mt-1 text-xs/5 text-muted-foreground",
              compact && "line-clamp-1"
            )}
          >
            {detail}
          </p>
        </div>

        {!uploading ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size={compact ? "sm" : "default"}
              disabled={inactive}
              onClick={() => inputRef.current?.click()}
            >
              <UploadIcon data-icon="inline-start" />
              {t(file ? "upload.changeFile" : "upload.selectFile")}
            </Button>
            {file ? (
              <Button
                type="button"
                variant="ghost"
                size={compact ? "icon-sm" : "icon"}
                disabled={inactive}
                aria-label={t("upload.removeFile", { fileName: file.name })}
                title={t("upload.removeSelectedFile")}
                onClick={clearFile}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}
