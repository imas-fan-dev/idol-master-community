import type { Config } from "@react-router/dev/config"

export default {
  ssr: false,
  // Dynamic Chronicle and admin routes use the SPA fallback. API and media
  // routes stay outside this list and continue to be routed to Hono.
  prerender: [
    "/",
    "/about",
    "/events",
    "/recommendations",
    "/live",
    "/community",
    "/account/login",
    "/account/register",
    "/community/exchange",
    "/community/cards",
    "/producer-map",
    "/works",
    "/works/765",
    "/works/cg",
    "/works/ml",
    "/works/sidem",
    "/works/sc",
    "/works/gakuen",
    "/works/games",
    "/works/wows",
    "/wiki",
    "/wiki/modern",
    "/wiki/classic",
    "/story",
    "/story/modern",
    "/story/classic",
    "/chronicle",
  ],
} satisfies Config
