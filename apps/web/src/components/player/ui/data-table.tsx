/**
 * DataTable — Generic TanStack/react-table wrapper using shadcn Table primitives.
 * ---------------------------------------------------------------------------
 * Provides pagination, column-based rendering, and controlled selection.
 * Uses shadcn Table, TableHeader, TableBody, TableRow, TableHead, TableCell.
 * Selection is fully controlled (lifted state) — no internal selection tracking.
 * Supports optional row-level state props (selected, incompatible) for CSS hooks.
 * Footer always renders when data exists; optional footerStart slot for counts.
 * --------------------------------------------------------------------------- */

import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type Table as TanStackTable,
} from '@tanstack/react-table';
import { Button } from '@/components/player/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/player/ui/table';

/** Per-row visual states applied as data attributes and optional class. */
export interface RowState {
  selected?: boolean;
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  pageSize?: number;
  /** Localized pagination labels */
  paginationLabels?: {
    previous: string;
    next: string;
    pageInfo: (page: number, totalPages: number) => string;
  };
  /** Accessible label for the table */
  ariaLabel?: string;
  /** Empty state content when data is empty */
  emptyContent?: React.ReactNode;
  /** Loading state content */
  loadingContent?: React.ReactNode;
  isLoading?: boolean;
  /** Optional per-row state provider — maps row index to visual states */
  getRowState?: (rowIndex: number, original: TData) => RowState;
  /** Content rendered at the left side of the unified footer (e.g. selection count) */
  footerStart?: React.ReactNode;
}

export function DataTable<TData>({
  columns,
  data,
  pageSize = 10,
  paginationLabels,
  ariaLabel,
  emptyContent,
  loadingContent,
  isLoading,
  getRowState,
  footerStart,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize },
    },
  });

  const hasData = !isLoading && table.getRowModel().rows.length > 0;
  const showFooter = hasData || footerStart;

  return (
    <div className="entei-data-table">
      <Table aria-label={ariaLabel}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="entei-data-table-empty"
              >
                {loadingContent ?? 'Loading…'}
              </TableCell>
            </TableRow>
          ) : table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="entei-data-table-empty"
              >
                {emptyContent ?? 'No results.'}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => {
              const rowState = getRowState?.(row.index, row.original);
              const isSelected = rowState?.selected ?? false;
              return (
                <TableRow
                  key={row.id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={
                    isSelected ? 'entei-data-table-row-selected' : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {showFooter && (
        <div className="entei-data-table-footer">
          {footerStart && (
            <span className="entei-data-table-footer-start">{footerStart}</span>
          )}
          {table.getPageCount() > 1 && (
            <div className="entei-data-table-pagination">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                {paginationLabels?.previous ?? '←'}
              </Button>
              <span className="entei-data-table-page-info">
                {paginationLabels?.pageInfo
                  ? paginationLabels.pageInfo(
                      table.getState().pagination.pageIndex + 1,
                      table.getPageCount(),
                    )
                  : `${table.getState().pagination.pageIndex + 1} / ${table.getPageCount()}`}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                {paginationLabels?.next ?? '→'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type { TanStackTable as DataTableInstance };
