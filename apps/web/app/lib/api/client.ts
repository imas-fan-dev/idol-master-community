import { createAlova } from "alova"
import adapterFetch from "alova/fetch"
import ReactHook from "alova/react"

import { normalizeRequestError } from "./api-error"
import { applyApiRequestPolicy } from "./request"
import { handleApiResponse } from "./response"

export const apiClient = createAlova({
  statesHook: ReactHook,
  requestAdapter: adapterFetch(),
  cacheFor: null,
  beforeRequest: (method) => {
    applyApiRequestPolicy(method)
  },
  responded: {
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
  },
})
