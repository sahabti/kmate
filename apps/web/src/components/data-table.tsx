import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronsUpDown, ChevronUp, X } from "lucide-react";
import { EmptyState } from "@/components/status";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /**
   * "120px" fixes the column; "minmax(160px,1fr)" (or no width) lets it share
   * the remaining space with the given minimum. Either way the column is never
   * narrower than its header.
   */
  width?: string;
  mono?: boolean;
  /** Counts and quantities: tabular figures so digits line up down the column. */
  numeric?: boolean;
  /** Sort key. A string key is also the hover text of a truncated cell. */
  value?: (row: T) => string | number | undefined;
  /** Hover text when it differs from the sort key, e.g. the absolute time behind an age. */
  title?: (row: T) => string | undefined;
}

interface SortState {
  id: string;
  desc: boolean;
}

type Sort = SortState | null;

/** Rows beyond this are virtualized; below it the table renders every row. */
const VIRTUALIZE_AFTER = 100;
/** Single-line row: 12px vertical padding around 20px of text, plus the border. */
const ROW_HEIGHT = 45;
/** Cell spacing; TableHead and TableCell may set spacing (see the lint contracts). */
const HEAD = "h-11 px-4";
const CELL = "px-4 py-3";
/** Rough width of one header character at text-sm, plus cell padding and the sort button. */
const CHAR_PX = 7.5;
const CELL_PAD_PX = 16;
const SORT_BUTTON_PX = 36;

interface ColumnWidth {
  fixed?: number;
  min: number;
}

const columnWidth = <T,>(c: Column<T>): ColumnWidth => {
  const header = Math.ceil(c.header.length * CHAR_PX + CELL_PAD_PX + (c.value ? SORT_BUTTON_PX : 0));
  const px = c.width?.match(/^(\d+)px$/);
  if (px) {
    const fixed = Math.max(Number(px[1]), header);

    return { fixed, min: fixed };
  }
  const minmax = c.width?.match(/^minmax\((\d+)px/);

  return { min: Math.max(minmax ? Number(minmax[1]) : 120, header) };
};

/**
 * Header label box, after Hirael's data-table column header. Sortable and plain
 * headers share it and inherit the table head's type, so labels line up.
 */
const HEADER_LABEL = "-ms-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * The table's own frame: muted header row, and the states shadcn's rows don't
 * have (clickable, keyboard-focused, empty), set here rather than restyling
 * TableRow.
 */
const FRAME = cn(
  "overflow-hidden rounded-xl border bg-card",
  // Header: a quiet tinted band with muted labels, so the rows carry the weight.
  "[&_thead]:bg-muted/50 [&_th]:text-muted-foreground",
  "[&_tr[data-clickable]]:cursor-pointer [&_tr[data-clickable]]:outline-none",
  "[&_tr[data-clickable]:focus-visible]:bg-muted/50 [&_tr[data-clickable]:focus-visible]:ring-2 [&_tr[data-clickable]:focus-visible]:ring-ring/50 [&_tr[data-clickable]:focus-visible]:ring-inset",
  "[&_tr[data-empty]:hover]:bg-transparent",
);

/** Pages scroll inside the app shell's body, marked with this slot. */
const SCROLL_SLOT = "[data-slot=app-scroll]";

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  /** Accessible name for a clickable row, e.g. the resource name. */
  rowLabel?: (r: T) => string;
  /** First load: show skeleton rows instead of the empty state. */
  loading?: boolean;
  /** Replaces the default empty state entirely. */
  empty?: ReactNode;
  emptyIcon?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

/**
 * The one table for lists, built from shadcn's table parts with their default
 * look. It grows with its rows and scrolls with the page; long lists are
 * virtualized against the page's scroll container. Adds sorting,
 * keyboard-openable rows, a loading skeleton and an empty state.
 */
export const DataTable = <T,>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowLabel,
  loading = false,
  empty,
  emptyIcon,
  emptyTitle = "Nothing here yet",
  emptyHint,
  className,
}: DataTableProps<T>) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [sort, setSort] = useState<Sort>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = columns.find((c) => c.id === sort.id)?.value;
    if (!get) return rows;

    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === bv) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });

      return sort.desc ? -cmp : cmp;
    });
  }, [rows, columns, sort]);

  const virtual = sorted.length > VIRTUALIZE_AFTER;

  // Find the page's scroll container and where the table starts inside it.
  useLayoutEffect(() => {
    if (!virtual) return;
    const frame = frameRef.current;
    const el = frame?.closest<HTMLElement>(SCROLL_SLOT) ?? null;
    setScroller(el);
    if (frame && el) setScrollMargin(frame.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
  }, [virtual]);

  // TanStack Virtual hands back fresh functions each render, which the React
  // Compiler cannot memoize; there is no compiler-safe virtualizer to swap in.
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: virtual && scroller ? sorted.length : 0,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
  });
  const items = virtual && scroller ? v.getVirtualItems() : null;
  const padTop = items?.length ? items[0]!.start - scrollMargin : 0;
  const padBottom = items?.length ? v.getTotalSize() - (items[items.length - 1]!.end - scrollMargin) : 0;
  const visible = items ? items.map((i) => sorted[i.index]!) : sorted;

  const widths = columns.map(columnWidth);
  const minWidth = widths.reduce((sum, w) => sum + w.min, 0);


  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  const titleOf = (c: Column<T>, row: T) => {
    if (c.title) return c.title(row);
    const val = c.value?.(row);

    return typeof val === "string" && val !== "" ? val : undefined;
  };

  return (
    <div ref={frameRef} data-slot="data-table" className={cn(FRAME, className)}>
      <Table className="table-fixed" style={{ minWidth }}>
        <colgroup>
          {widths.map((w, i) => (
            <col key={columns[i]!.id} style={w.fixed ? { width: w.fixed } : undefined} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              const ariaSort = active ? (sort.desc ? "descending" : "ascending") : c.value ? "none" : undefined;

              return (
                <TableHead key={c.id} aria-sort={ariaSort} className={HEAD}>
                  {c.value ? (
                    // Sort menu after Hirael's data-table column header.
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className={cn(HEADER_LABEL, "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-accent")}>
                          {c.header}
                          {active ? sort.desc ? <ChevronDown /> : <ChevronUp /> : <ChevronsUpDown className="text-muted-foreground" />}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-36">
                        <DropdownMenuItem onSelect={() => setSort({ id: c.id, desc: false })}>
                          <ChevronUp /> Ascending
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setSort({ id: c.id, desc: true })}>
                          <ChevronDown /> Descending
                        </DropdownMenuItem>
                        {active && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setSort(null)}>
                              <X /> Reset
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    // Same box as the sort trigger, so plain and sortable headers line up.
                    <span className={HEADER_LABEL}>{c.header}</span>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            sorted.length === 0 &&
            Array.from({ length: 5 }, (_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {columns.map((c) => (
                  <TableCell key={c.id} className={CELL}>
                    <Skeleton className="h-5 w-3/4" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {!loading && sorted.length === 0 && (
            <TableRow data-empty>
              <TableCell colSpan={columns.length} className={cn(CELL, "whitespace-normal")}>
                {empty ?? <EmptyState icon={emptyIcon} title={emptyTitle} hint={emptyHint} />}
              </TableCell>
            </TableRow>
          )}
          {padTop > 0 && (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: padTop }} />
            </tr>
          )}
          {visible.map((row) => (
            <TableRow
              key={rowKey(row)}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
              data-clickable={onRowClick ? true : undefined}
            >
              {columns.map((c) => (
                <TableCell key={c.id} title={titleOf(c, row)} className={CELL}>
                  <div className={cn("truncate", c.numeric && "tabular-nums", c.mono && "font-mono")}>{c.cell(row)}</div>
                </TableCell>
              ))}
            </TableRow>
          ))}
          {padBottom > 0 && (
            <tr aria-hidden>
              <td colSpan={columns.length} style={{ height: padBottom }} />
            </tr>
          )}
        </TableBody>
      </Table>
    </div>
  );
};
