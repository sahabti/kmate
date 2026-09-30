import { useMemo } from "react";
import { Layers } from "lucide-react";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/combobox";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/** Searchable namespace selector (Hirael Combobox). Empty string = all namespaces. */
export function NamespacePicker({ namespaces, value, onChange, className }: { namespaces: string[]; value: string; onChange: (ns: string) => void; className?: string }) {
  const items = useMemo(() => [ALL, ...namespaces], [namespaces]);
  const label = (v: string | null) => (!v || v === ALL ? "All namespaces" : v);
  return (
    <Combobox<string, false>
      items={items}
      value={value || ALL}
      onValueChange={(v) => onChange(!v || v === ALL ? "" : v)}
      itemToStringLabel={label}
    >
      <ComboboxInput placeholder="Namespace" aria-label="Namespace" className={cn("h-8 w-36 sm:w-52", className)} inputClassName="text-xs">
        <Layers className="ms-2 size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>No namespaces</ComboboxEmpty>
        <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item} className="text-xs">{label(item)}</ComboboxItem>}</ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
