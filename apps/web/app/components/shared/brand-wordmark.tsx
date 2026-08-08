import { cn } from "~/lib/utils"

type BrandWordmarkProps = {
  className?: string
  alt?: string
}

export function BrandWordmark({
  className,
  alt = "偶像大师交流站",
}: BrandWordmarkProps) {
  return (
    <img
      className={cn("h-8 w-auto shrink-0 object-contain", className)}
      src="/brand/imsweb-logo.webp"
      alt={alt}
      width={545}
      height={188}
      decoding="async"
    />
  )
}
