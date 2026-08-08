import { createAlova } from "alova"
import { createServerTokenAuthentication } from "alova/client"
import adapterFetch from "alova/fetch"
import ReactHook from "alova/react"

import { normalizeRequestError } from "./api-error"
import { readCookie } from "./cookies"
import { applyApiRequestPolicy, PLATFORM_CSRF_COOKIE_NAME } from "./request"
import { handleApiResponse } from "./response"
import { withPlatformCsrf } from "./types"

// Alova clones Method objects for replays and preserves enumerable symbol fields.
const failedRefreshReplay = Symbol("failed-platform-refresh-replay")
const requestCsrfTokens = new WeakMap<object, string | undefined>()

function markFailedRefreshReplay(method: object) {
  const markedMethod = method as { [failedRefreshReplay]?: boolean }
  markedMethod[failedRefreshReplay] = true
}

function consumeFailedRefreshReplay(method: object) {
  const markedMethod = method as { [failedRefreshReplay]?: boolean }
  const marked = Boolean(markedMethod[failedRefreshReplay])
  if (marked) {
    delete markedMethod[failedRefreshReplay]
  }
  return marked
}

let markRefreshWaveFailed = markFailedRefreshReplay

async function withPlatformRefreshLock(refresh: () => Promise<void>) {
  if (typeof navigator === "undefined" || !navigator.locks) {
    await refresh()
    return
  }
  await navigator.locks.request("imsweb-platform-refresh", refresh)
}

const platformAuthentication = createServerTokenAuthentication<
  typeof ReactHook,
  typeof adapterFetch
>({
  visitorMeta: { authRole: "logout" },
  refreshTokenOnSuccess: {
    isExpired: (response, method) => {
      if (consumeFailedRefreshReplay(method)) {
        return false
      }
      return response.status === 401
    },
    handler: async (_response, method) => {
      const requestCsrfToken = requestCsrfTokens.get(method)
      try {
        await withPlatformRefreshLock(async () => {
          // Another tab may have rotated the cookies while this request was in flight.
          if (readCookie(PLATFORM_CSRF_COOKIE_NAME) !== requestCsrfToken) {
            return
          }
          await method.context.Post("/api/platform/auth/refresh", undefined, {
            meta: withPlatformCsrf({ authRole: "refreshToken" }),
          })
        })
      } catch {
        markRefreshWaveFailed(method)
      }
    },
  },
})

const { onAuthRequired, onResponseRefreshToken, waitingList } =
  platformAuthentication

markRefreshWaveFailed = (method) => {
  markFailedRefreshReplay(method)
  for (const waiter of waitingList) {
    markFailedRefreshReplay(waiter.method)
  }
}

export const platformApiClient = createAlova({
  statesHook: ReactHook,
  requestAdapter: adapterFetch(),
  cacheFor: null,
  beforeRequest: onAuthRequired((method) => {
    requestCsrfTokens.set(method, readCookie(PLATFORM_CSRF_COOKIE_NAME))
    applyApiRequestPolicy(method, {
      authRealm: "platform",
      csrfCookieName: PLATFORM_CSRF_COOKIE_NAME,
    })
  }),
  responded: onResponseRefreshToken({
    onSuccess: (response, method) =>
      handleApiResponse(response, {
        method: method.type,
        url: method.url,
        meta: method.meta,
      }),
    onError: (error, method) => {
      consumeFailedRefreshReplay(method)
      throw normalizeRequestError(error, {
        method: method.type,
        url: method.url,
        meta: method.meta,
      })
    },
  }),
})
