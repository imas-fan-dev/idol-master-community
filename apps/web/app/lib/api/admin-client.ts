import { createAlova } from "alova"
import { createServerTokenAuthentication } from "alova/client"
import adapterFetch from "alova/fetch"
import ReactHook from "alova/react"

import { normalizeRequestError } from "./api-error"
import {
  applyApiRequestPolicy,
  BACKOFFICE_CSRF_COOKIE_NAME,
  LEGACY_BACKOFFICE_CSRF_COOKIE_NAME,
} from "./request"
import { handleApiResponse } from "./response"
import { withBackofficeCsrf } from "./types"

let failedRefreshReplayBudget = 0
let markRefreshWaveFailed = () => {
  failedRefreshReplayBudget = 1
}

const backofficeAuthentication = createServerTokenAuthentication<
  typeof ReactHook,
  typeof adapterFetch
>({
  visitorMeta: { authRole: "logout" },
  refreshTokenOnSuccess: {
    isExpired: (response) => {
      if (failedRefreshReplayBudget > 0) {
        failedRefreshReplayBudget -= 1
        return false
      }
      return response.status === 401
    },
    handler: async (_response, method) => {
      try {
        await method.context.Post("/api/admin/auth/refresh", undefined, {
          meta: withBackofficeCsrf({ authRole: "refreshToken" }),
        })
      } catch {
        // Alova 3.5 clears failed refresh waiters without rejecting them.
        // Treat this refresh wave as completed so every caller can settle.
        markRefreshWaveFailed()
      }
    },
  },
})

const { onAuthRequired, onResponseRefreshToken, waitingList } =
  backofficeAuthentication

markRefreshWaveFailed = () => {
  failedRefreshReplayBudget = waitingList.length + 1
}

export const adminApiClient = createAlova({
  statesHook: ReactHook,
  requestAdapter: adapterFetch(),
  cacheFor: null,
  beforeRequest: onAuthRequired((method) => {
    applyApiRequestPolicy(method, {
      authRealm: "backoffice",
      csrfCookieName: BACKOFFICE_CSRF_COOKIE_NAME,
      csrfFallbackCookieNames: [LEGACY_BACKOFFICE_CSRF_COOKIE_NAME],
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
      throw normalizeRequestError(error, {
        method: method.type,
        url: method.url,
        meta: method.meta,
      })
    },
  }),
})
