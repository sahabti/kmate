import { cn } from "@/lib/utils";

/*
 * KMate's mark after Hirael's logo system: one solid geometric path drawn in
 * currentColor, used three ways (lockup, bare mark, tile). The K is a stem the
 * weight of Hirael's verticals plus a notched chevron whose edges run parallel,
 * so the stroke weight stays even. public/favicon.svg draws the same path.
 */
const MARK_PATH = "M0 .5h6.2v23H0ZM6.2 8.9 13 .5h7l-9.3 11.5L20 23.5h-7l-6.8-8.4Z";
const MARK_VIEWBOX = "0 0 20 24";

interface MarkSvgProps {
  className?: string;
}

const MarkSvg = ({ className }: MarkSvgProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox={MARK_VIEWBOX} fill="currentColor" aria-hidden className={className}>
    <path d={MARK_PATH} />
  </svg>
);

interface LogoProps {
  className?: string;
}

/** Mark plus wordmark. Size it with a text size; the mark follows the cap height. */
export const Logo = ({ className }: LogoProps) => (
  <span role="img" aria-label="KMate" className={cn("inline-flex shrink-0 items-center gap-2 font-semibold tracking-tight text-foreground", className)}>
    <MarkSvg className="h-[0.9em] w-auto" />
    <span aria-hidden>KMate</span>
  </span>
);

interface LogoMarkProps {
  className?: string;
}

/** The mark alone, for tight spaces. */
export const LogoMark = ({ className }: LogoMarkProps) => (
  <span role="img" aria-label="KMate" className={cn("inline-flex size-6 shrink-0 items-center justify-center text-foreground", className)}>
    <MarkSvg className="h-full w-auto" />
  </span>
);

interface LogoTileProps {
  className?: string;
}

/** The mark on a raised tile: sidebar header, sign-in page, app icon. */
export const LogoTile = ({ className }: LogoTileProps) => (
  <span
    role="img"
    aria-label="KMate"
    className={cn(
      "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-input bg-linear-to-b from-card to-card/80 text-foreground shadow-sm select-none",
      className,
    )}
  >
    <MarkSvg className="h-[52%] w-auto" />
  </span>
);
