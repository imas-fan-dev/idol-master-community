import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  getPlatformSession,
  hasPlatformSessionHint,
  isApiError,
  logoutPlatform,
  type PlatformSession,
} from "~/lib/api"

export type PlatformSessionStatus =
  | "anonymous"
  | "loading"
  | "authenticated"
  | "restricted"
  | "error"

interface PlatformSessionState {
  status: PlatformSessionStatus
  session: PlatformSession | null
  error: unknown | null
}

interface PlatformSessionContextValue extends PlatformSessionState {
  acceptSession: (session: PlatformSession) => void
  reload: () => Promise<void>
  logout: () => Promise<void>
}

const anonymousState: PlatformSessionState = {
  status: "anonymous",
  session: null,
  error: null,
}

const PlatformSessionContext = createContext<
  PlatformSessionContextValue | undefined
>(undefined)

function resolvedSessionState(session: PlatformSession): PlatformSessionState {
  return {
    status:
      session.account.status === "restricted" ? "restricted" : "authenticated",
    session,
    error: null,
  }
}

function rejectedSessionState(error: unknown): PlatformSessionState {
  if (isApiError(error) && (error.status === 401 || error.status === 403)) {
    return anonymousState
  }
  return { status: "error", session: null, error }
}

export function PlatformSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlatformSessionState>(anonymousState)
  const requestGeneration = useRef(0)

  const acceptSession = useCallback((session: PlatformSession) => {
    requestGeneration.current += 1
    setState(resolvedSessionState(session))
  }, [])

  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (!hasPlatformSessionHint()) {
      setState(anonymousState)
      return
    }

    setState({ status: "loading", session: null, error: null })
    try {
      const session = await getPlatformSession().send()
      if (requestGeneration.current === generation) {
        setState(resolvedSessionState(session))
      }
    } catch (error) {
      if (requestGeneration.current === generation) {
        setState(rejectedSessionState(error))
      }
    }
  }, [])

  const logout = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (!hasPlatformSessionHint()) {
      setState(anonymousState)
      return
    }

    setState({ status: "loading", session: null, error: null })
    try {
      await logoutPlatform().send()
      if (requestGeneration.current === generation) {
        setState(anonymousState)
      }
    } catch (error) {
      if (requestGeneration.current === generation) {
        setState(rejectedSessionState(error))
      }
    }
  }, [])

  useEffect(() => {
    const bootstrapTimer = window.setTimeout(() => {
      void reload()
    }, 0)
    return () => {
      window.clearTimeout(bootstrapTimer)
      requestGeneration.current += 1
    }
  }, [reload])

  const value = useMemo<PlatformSessionContextValue>(
    () => ({ ...state, acceptSession, reload, logout }),
    [acceptSession, logout, reload, state]
  )

  return (
    <PlatformSessionContext.Provider value={value}>
      {children}
    </PlatformSessionContext.Provider>
  )
}

export function usePlatformSession(): PlatformSessionContextValue {
  const context = useContext(PlatformSessionContext)
  if (!context) {
    throw new Error(
      "usePlatformSession must be used within PlatformSessionProvider"
    )
  }
  return context
}
