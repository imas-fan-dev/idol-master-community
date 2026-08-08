import {
  FileImageIcon,
  ImageOffIcon,
  ImageUpIcon,
  LoaderCircleIcon,
  UploadIcon,
} from "lucide-react"
import { useEffect, useMemo } from "react"

import { CoverImagePreview } from "~/components/shared/cover-image-preview"
import { FileUploadControl } from "~/components/shared/file-upload-control"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field"
import { Input } from "~/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs"
import { Textarea } from "~/components/ui/textarea"
import type {
  FudabaCardFields,
  FudabaCardMediaSide,
  FudabaSeries,
} from "~/lib/api"

export function useObjectUrl(file: File | null) {
  const url = useMemo(() => {
    if (!file || typeof URL.createObjectURL !== "function") return null
    return URL.createObjectURL(file)
  }, [file])

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  return url
}

export function CardPreview({
  frontUrl,
  backUrl,
  displayName,
}: {
  frontUrl: string | null
  backUrl: string | null
  displayName: string
}) {
  return (
    <Tabs defaultValue="front" className="min-w-0">
      <TabsList className="w-full" aria-label="名片预览面">
        <TabsTrigger value="front">正面预览</TabsTrigger>
        <TabsTrigger value="back">背面预览</TabsTrigger>
      </TabsList>
      {(
        [
          ["front", frontUrl, "正面"],
          ["back", backUrl, "背面"],
        ] as const
      ).map(([side, url, label]) => (
        <TabsContent key={side} value={side} className="mt-3">
          {url ? (
            <CoverImagePreview
              src={url}
              alt={`${displayName || "新名片"}${label}`}
              previewLabel="名片"
              className="aspect-3/2 w-full border bg-muted"
              imageClassName="object-contain"
            />
          ) : (
            <div className="flex aspect-3/2 w-full items-center justify-center border bg-muted/40 text-muted-foreground">
              <div className="flex flex-col items-center gap-2 text-sm">
                <ImageOffIcon aria-hidden="true" />
                尚未选择{label}图片
              </div>
            </div>
          )}
        </TabsContent>
      ))}
    </Tabs>
  )
}

export function CardFields({
  draft,
  series,
  disabled,
  onChange,
}: {
  draft: FudabaCardFields
  series: FudabaSeries[]
  disabled: boolean
  onChange: (draft: FudabaCardFields) => void
}) {
  return (
    <FieldGroup>
      <FieldGroup className="grid gap-5 sm:grid-cols-2">
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="exchange-card-producer-name">
            制作人名称
          </FieldLabel>
          <Input
            id="exchange-card-producer-name"
            value={draft.producerName}
            maxLength={80}
            required
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, producerName: event.currentTarget.value })
            }
          />
        </Field>
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="exchange-card-display-name">名片标题</FieldLabel>
          <Input
            id="exchange-card-display-name"
            value={draft.displayName}
            maxLength={120}
            required
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, displayName: event.currentTarget.value })
            }
          />
        </Field>
      </FieldGroup>

      <FieldGroup className="grid gap-5 sm:grid-cols-2">
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="exchange-card-series">所属企划</FieldLabel>
          <Select
            value={draft.seriesCode || undefined}
            disabled={disabled || series.length === 0}
            onValueChange={(value) =>
              onChange({ ...draft, seriesCode: String(value ?? "") })
            }
          >
            <SelectTrigger id="exchange-card-series" className="w-full">
              <SelectValue placeholder="选择企划" />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {series.map((item) => (
                  <SelectItem key={item.code} value={item.code}>
                    {item.displayName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="exchange-card-favorite-idol">
            喜欢的偶像
          </FieldLabel>
          <Input
            id="exchange-card-favorite-idol"
            value={draft.favoriteIdol}
            maxLength={200}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, favoriteIdol: event.currentTarget.value })
            }
          />
        </Field>
      </FieldGroup>

      <Field data-disabled={disabled || undefined}>
        <FieldLabel htmlFor="exchange-card-accent">名片强调色</FieldLabel>
        <div className="flex min-w-0 items-center gap-3">
          <Input
            id="exchange-card-accent"
            type="color"
            value={draft.accent}
            disabled={disabled}
            className="size-10 shrink-0 cursor-pointer p-1"
            onChange={(event) =>
              onChange({ ...draft, accent: event.currentTarget.value })
            }
          />
          <output className="min-w-0 font-mono text-sm text-muted-foreground">
            {draft.accent.toUpperCase()}
          </output>
        </div>
      </Field>

      <Field data-disabled={disabled || undefined}>
        <FieldLabel htmlFor="exchange-card-bio">名片简介</FieldLabel>
        <Textarea
          id="exchange-card-bio"
          value={draft.bio}
          maxLength={2000}
          disabled={disabled}
          className="min-h-24 resize-y"
          onChange={(event) =>
            onChange({ ...draft, bio: event.currentTarget.value })
          }
        />
      </Field>

      <Field data-disabled={disabled || undefined}>
        <FieldLabel htmlFor="exchange-card-trade-note">交换说明</FieldLabel>
        <Textarea
          id="exchange-card-trade-note"
          value={draft.tradeNote}
          maxLength={1000}
          disabled={disabled}
          className="min-h-20 resize-y"
          onChange={(event) =>
            onChange({ ...draft, tradeNote: event.currentTarget.value })
          }
        />
      </Field>

      <Field orientation="horizontal" data-disabled={disabled || undefined}>
        <Checkbox
          id="exchange-card-available"
          checked={draft.available}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...draft, available: checked === true })
          }
        />
        <div className="min-w-0">
          <FieldLabel htmlFor="exchange-card-available">接受交换</FieldLabel>
          <FieldDescription>
            关闭后名片仍可保存和审核，但不会标记为可交换。
          </FieldDescription>
        </div>
      </Field>
    </FieldGroup>
  )
}

export function CardImageFields({
  mode,
  frontFile,
  backFile,
  disabled,
  saving,
  uploadingSide,
  onSelect,
  onUpload,
}: {
  mode: "create" | "replace"
  frontFile: File | null
  backFile: File | null
  disabled: boolean
  saving: boolean
  uploadingSide: FudabaCardMediaSide | null
  onSelect: (file: File | null, side: FudabaCardMediaSide) => void
  onUpload?: (side: FudabaCardMediaSide) => void
}) {
  return (
    <FieldGroup className="grid gap-5 md:grid-cols-2">
      {(
        [
          ["front", "正面", frontFile],
          ["back", "背面", backFile],
        ] as const
      ).map(([side, label, file]) => (
        <Field key={side} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`exchange-card-${side}`}>名片{label}</FieldLabel>
          <FileUploadControl
            id={`exchange-card-${side}`}
            compact
            accept="image/*"
            emptyTitle={
              mode === "create" ? `选择名片${label}` : `选择新的名片${label}`
            }
            emptyDetail="图片文件 · 不超过 8 MiB"
            fileKind={`名片${label}`}
            file={file}
            disabled={disabled}
            uploading={mode === "create" ? saving : uploadingSide === side}
            required={mode === "create"}
            selectedIcon={FileImageIcon}
            emptyIcon={ImageUpIcon}
            onSelect={(nextFile) => onSelect(nextFile, side)}
          />
          {mode === "replace" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={disabled || !file}
              onClick={() => onUpload?.(side)}
            >
              {uploadingSide === side ? (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <UploadIcon data-icon="inline-start" aria-hidden="true" />
              )}
              {uploadingSide === side ? "正在上传" : `替换${label}`}
            </Button>
          ) : null}
        </Field>
      ))}
    </FieldGroup>
  )
}
