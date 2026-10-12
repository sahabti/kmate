import * as React from "react"

const MOBILE_BREAKPOINT = 768

const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", onChange)

  return () => mql.removeEventListener("change", onChange)
}

const getSnapshot = () => window.innerWidth < MOBILE_BREAKPOINT

// An external store instead of effect + state, so the first render already has the answer.
export const useIsMobile = () => React.useSyncExternalStore(subscribe, getSnapshot)
