import { useRequest } from "alova/client"
import { ArrowUpRightIcon } from "lucide-react"

import { CoverImagePreview } from "~/components/shared/cover-image-preview"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Skeleton } from "~/components/ui/skeleton"
import { getHomeInformation } from "~/lib/api"

function isExternalLink(href: string) {
  return href.startsWith("http://") || href.startsWith("https://")
}

export function ActivityHighlights() {
  const { data, loading, error, onError } = useRequest(getHomeInformation(), {
    initialData: { cards: [] },
  })
  onError(() => undefined)
  const items = data.cards.map((card) => ({
    category: card.category === "activity" ? "活动资讯" : "同人活动",
    title: card.title,
    href: card.link,
    image: card.image,
  }))

  return (
    <section
      className="border-y bg-muted/20"
      aria-labelledby="highlights-heading"
    >
      <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-7">
          <p className="text-xs font-semibold text-primary">SPOTLIGHTS</p>
          <h2 id="highlights-heading" className="mt-2 text-2xl font-semibold">
            活动资讯与同人活动
          </h2>
        </div>
        {loading ? (
          <div
            className="grid grid-cols-2 gap-4 lg:grid-cols-3"
            role="status"
            aria-label="正在加载活动资讯"
          >
            {[0, 1, 2].map((item) => (
              <div key={item} className="overflow-hidden rounded-md border">
                <Skeleton className="aspect-video w-full" />
                <div className="space-y-2 p-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-5 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <Alert>
            <AlertTitle>活动资讯暂时不可用</AlertTitle>
            <AlertDescription>稍后刷新即可重新获取。</AlertDescription>
          </Alert>
        ) : items.length ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {items.map((item) => {
              const external = isExternalLink(item.href)
              return (
                <article
                  key={item.href + item.title}
                  className="group overflow-hidden rounded-md border bg-card transition-colors hover:border-foreground/25"
                >
                  <CoverImagePreview
                    src={item.image}
                    alt={`${item.title}封面`}
                    className="aspect-video w-full rounded-none bg-muted"
                    imageClassName="transition-transform duration-300 group-hover:scale-[1.025]"
                  />
                  <a
                    href={item.href}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noreferrer" : undefined}
                    className="flex min-h-20 items-center gap-3 px-4 py-3 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-primary">
                        {item.category}
                      </span>
                      <span className="mt-1 block font-medium">
                        {item.title}
                      </span>
                    </span>
                    <ArrowUpRightIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </a>
                </article>
              )
            })}
          </div>
        ) : (
          <p className="border-y py-8 text-sm text-muted-foreground">
            当前没有已发布的活动资讯。
          </p>
        )}
      </div>
    </section>
  )
}
