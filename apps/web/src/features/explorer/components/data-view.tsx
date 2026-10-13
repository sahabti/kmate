import { useState } from "react";
import { Eye, EyeOff, FileLock2 } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/status";
import { Button } from "@/components/ui/button";
import { dataEntries, type DataEntry } from "@/features/explorer/lib/secret-data";
import type { KObj } from "@/lib/k8s";
import { cn } from "@/lib/utils";

interface DataViewProps {
  obj: KObj;
}

interface DataRowProps {
  entry: DataEntry;
  /** Secrets start hidden; a ConfigMap has nothing to hide. */
  secret: boolean;
  revealed: boolean;
  onToggle: () => void;
}

const DataRow = ({ entry, secret, revealed, onToggle }: DataRowProps) => {
  const show = !secret || revealed;
  const binary = entry.text === null;

  return (
    <div className="flex flex-col gap-1.5 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-xs font-medium">{entry.key}</span>
        <span className="text-xs text-muted-foreground">
          {entry.bytes} bytes{binary && " · binary"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {secret && !binary && (
            <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label={revealed ? `Hide ${entry.key}` : `Reveal ${entry.key}`}>
              {revealed ? <EyeOff /> : <Eye />}
            </Button>
          )}
          {/* Copies the decoded value, which is what someone pasting it needs;
              a binary value has no text form, so its base64 is the useful thing. */}
          <CopyButton value={entry.text ?? ""} size="sm" label={`Copy ${entry.key}`} disabled={binary} />
        </div>
      </div>
      {binary ? (
        <p className="text-xs text-muted-foreground">Not valid UTF-8 text. Use the YAML tab for the base64 form.</p>
      ) : (
        <pre className={cn("max-h-48 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap", !show && "select-none")}>
          {show ? entry.text : "•".repeat(Math.min(entry.bytes, 48))}
        </pre>
      )}
    </div>
  );
};

/**
 * Keys and values of a Secret or ConfigMap, decoded.
 *
 * The API server returns Secret values base64-encoded, which the YAML tab shows
 * verbatim. Decoding here is a convenience, not extra access: anyone who can
 * read the object already has the bytes.
 */
export const DataView = ({ obj }: DataViewProps) => {
  const entries = dataEntries(obj);
  const secret = obj.kind === "Secret";
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const allRevealed = entries.length > 0 && entries.every((e) => e.text === null || revealed.has(e.key));

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);

      return next;
    });

  if (entries.length === 0) {
    return <EmptyState icon={<FileLock2 />} title="No data" hint={secret ? "This Secret has no keys." : "This ConfigMap has no keys."} />;
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      {secret && (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <p className="text-xs text-muted-foreground">Values are base64 in the API and decoded here.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevealed(allRevealed ? new Set() : new Set(entries.filter((e) => e.text !== null).map((e) => e.key)))}
          >
            {allRevealed ? <EyeOff /> : <Eye />}
            {allRevealed ? "Hide all" : "Reveal all"}
          </Button>
        </div>
      )}
      {entries.map((e) => (
        <DataRow key={e.key} entry={e} secret={secret} revealed={revealed.has(e.key)} onToggle={() => toggle(e.key)} />
      ))}
    </div>
  );
};
