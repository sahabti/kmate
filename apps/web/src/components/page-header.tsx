import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Inline next to the title: a count, a live status, a version. */
  meta?: ReactNode;
  /** One or two sentences under the title saying what the page is for. */
  description?: ReactNode;
  /** The page's primary action, top right. */
  actions?: ReactNode;
}

/**
 * Title block every page starts with, after Hirael's page-header blocks: title
 * and meta on one line, the description underneath, actions on the right.
 */
export const PageHeader = ({ title, meta, description, actions }: PageHeaderProps) => (
  <header data-slot="page-header" className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-8">
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {meta}
      </div>
      {description && <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
);
