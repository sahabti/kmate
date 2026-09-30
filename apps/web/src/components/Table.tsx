import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  width?: string; // css width e.g. "1fr", "120px"
  mono?: boolean;
}

/**
 * Virtualized table: shadcn table look, CSS-grid rows so TanStack Virtual can
 * absolutely position them. Scrolls horizontally on narrow screens.
 */
export function VirtualTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  emptyText = "No items",
  rowHeight = 34,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  emptyText?: string;
  rowHeight?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const grid = columns.map((c) => c.width ?? "minmax(120px,1fr)").join(" ");

  return (
    <div ref={parentRef} className="h-full overflow-auto rounded-lg border bg-card">
      <div className="min-w-max">
        <div
          data-slot="table-header"
          className="sticky top-0 z-10 grid border-b bg-card/95 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur supports-[backdrop-filter]:bg-card/80"
          style={{ gridTemplateColumns: grid }}
        >
          {columns.map((c) => (
            <div key={c.id} className="h-9 truncate px-3 leading-9">
              {c.header}
            </div>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="p-10 text-center text-xs text-muted-foreground">{emptyText}</div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const row = rows[vi.index]!;
              return (
                <div
                  key={rowKey(row)}
                  role={onRowClick ? "button" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn("grid items-center border-b text-xs transition-colors last:border-b-0", onRowClick && "cursor-pointer hover:bg-muted/60")}
                  style={{
                    gridTemplateColumns: grid,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {columns.map((c) => (
                    <div key={c.id} className={cn("truncate px-3", c.mono && "font-mono")}>
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Non-virtualized shadcn table for small lists. */
export function SimpleTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  emptyText = "No items",
  className,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  emptyText?: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-auto rounded-lg border bg-card", className)}>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => (
              <TableHead key={c.id} className="h-9 text-[11px] tracking-wide whitespace-nowrap uppercase">
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-8 text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
          {rows.map((r) => (
            <TableRow key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn(onRowClick && "cursor-pointer")}>
              {columns.map((c) => (
                <TableCell key={c.id} className={cn("py-1.5 whitespace-nowrap", c.mono && "font-mono")}>
                  {c.cell(r)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
