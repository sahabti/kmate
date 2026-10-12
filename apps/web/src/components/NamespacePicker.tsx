import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Searchable namespace selector, built as shadcn's combobox (Popover + Command).
 * Empty string = all namespaces.
 *
 * `allowAll` is false for a namespace-limited user: the hub refuses an
 * all-namespaces request from them, so offering it would only produce an error.
 */
export function NamespacePicker({ namespaces, value, onChange, className, allowAll = true }: { namespaces: string[]; value: string; onChange: (ns: string) => void; className?: string; allowAll?: boolean }) {
  const [open, setOpen] = useState(false);

  // Keep a restricted user pinned to a namespace they can actually read.
  useEffect(() => {
    if (allowAll || !namespaces.length) return;
    if (!value || !namespaces.includes(value)) onChange(namespaces[0]!);
  }, [allowAll, namespaces, value, onChange]);

  const pick = (ns: string) => {
    onChange(ns);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} aria-label="Namespace" className={cn("w-40 justify-between sm:w-52", className)}>
          <Layers className="text-muted-foreground" />
          <span className="flex-1 truncate text-start">{value || (allowAll ? "All namespaces" : "Namespace")}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search namespaces…" />
          <CommandList>
            <CommandEmpty>No namespaces found.</CommandEmpty>
            {allowAll && (
              <>
                <CommandGroup>
                  <CommandItem value="__all__" onSelect={() => pick("")}>
                    All namespaces
                    <Check className={cn("ms-auto", value ? "opacity-0" : "opacity-100")} />
                  </CommandItem>
                </CommandGroup>
                {namespaces.length > 0 && <CommandSeparator />}
              </>
            )}
            {namespaces.length > 0 && (
              <CommandGroup heading="Namespaces">
                {namespaces.map((ns) => (
                  <CommandItem key={ns} value={ns} onSelect={() => pick(ns)}>
                    {ns}
                    <Check className={cn("ms-auto", value === ns ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
