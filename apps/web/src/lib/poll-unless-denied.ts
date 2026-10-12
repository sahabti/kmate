import { denialFromError } from "@/lib/denial";

/**
 * Polling interval that stops once the request is refused. Re-asking a question
 * the hub or the API server already answered with "no" only adds console noise.
 */
export const pollUnlessDenied =
  (ms: number) =>
  // `any` keeps TanStack Query's data and error inference intact at each call
  // site; a concrete Query type here becomes an inference source and widens them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (q: any) =>
    denialFromError(q?.state?.error) ? false : ms;
