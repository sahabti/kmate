import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import yaml from "js-yaml";
import { Check, FileDiff, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { cluster, errorMessage } from "@/api/client";
import CodeEditor, { CodeDiff } from "@/cluster/CodeEditor";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { Spinner } from "@/components/spinner";
import { ErrorCallout } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { KObj } from "@/lib/k8s";

const DUMP = { noRefs: true, lineWidth: 120, sortKeys: false } as const;

/** Fields that must not be sent in a server-side apply body. */
function applyBody(obj: KObj): KObj {
  const { status: _status, ...rest } = obj;
  const m = { ...(rest.metadata ?? {}) } as Record<string, unknown>;
  for (const k of ["managedFields", "uid", "creationTimestamp", "generation", "resourceVersion", "selfLink"]) delete m[k];
  return { ...rest, metadata: m } as KObj;
}

/**
 * YAML tab: editable Monaco editor with diff preview + server-side apply.
 * Read-only when the agent lacks the "write" capability.
 */
export default function YamlView({ obj, clusterId, canWrite, onApplied }: { obj: KObj; clusterId?: string; canWrite?: boolean; onApplied?: () => void }) {
  const original = useMemo(() => yaml.dump(obj, DUMP), [obj]);
  const [text, setText] = useState(original);
  const [dirty, setDirty] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const qc = useQueryClient();

  // Refresh the editor when a new object arrives and the user hasn't edited.
  useEffect(() => {
    if (!dirty) setText(original);
  }, [original, dirty]);

  const editable = !!clusterId && !!canWrite;

  const parse = (): KObj | null => {
    try {
      const doc = yaml.load(text);
      if (!doc || typeof doc !== "object") throw new Error("document is not a mapping");
      return doc as KObj;
    } catch (e) {
      setErr(`Invalid YAML: ${errorMessage(e)}`);
      return null;
    }
  };

  const apply = async () => {
    const doc = parse();
    if (!doc || !clusterId) return;
    const body = applyBody(doc);
    setBusy(true);
    setErr(null);
    try {
      const json = new TextEncoder().encode(JSON.stringify(body));
      await cluster.apply({
        clusterId,
        apply: {
          object: { json, apiVersion: body.apiVersion ?? "", kind: body.kind ?? "", namespace: body.metadata?.namespace ?? "", name: body.metadata?.name ?? "" },
          force,
          fieldManager: "kmate",
          dryRun,
        },
      });
      setPreview(false);
      setConflict(false);
      if (dryRun) {
        toast.success("Dry run succeeded", { description: "The server accepted the object; nothing was changed." });
      } else {
        toast.success(`Applied ${body.kind}/${body.metadata?.name}`);
        setDirty(false);
        await qc.invalidateQueries({ queryKey: ["object", clusterId] });
        onApplied?.();
      }
    } catch (e) {
      const m = errorMessage(e);
      setErr(m);
      setConflict(/conflict/i.test(m));
      toast.error(dryRun ? "Dry run failed" : "Apply failed", { description: m });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
        {editable ? (
          <>
            <Button size="sm" variant="outline" disabled={!dirty} onClick={() => setPreview(true)}>
              <FileDiff /> Diff
            </Button>
            <Button size="sm" disabled={!dirty || busy} onClick={() => setPreview(true)}>
              {busy ? <Spinner size="sm" /> : <Save />} {dryRun ? "Dry run" : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setText(original);
                setDirty(false);
                setErr(null);
                setConflict(false);
              }}
            >
              <RotateCcw /> Reset
            </Button>
            <label className="ml-1 flex items-center gap-1.5 text-muted-foreground">
              <Switch size="sm" checked={dryRun} onCheckedChange={setDryRun} aria-label="Dry run" /> Dry run
            </label>
            {conflict && (
              <label className="flex items-center gap-1.5 text-warning">
                <Switch size="sm" checked={force} onCheckedChange={setForce} aria-label="Force" /> Force (take field ownership)
              </label>
            )}
            {dirty && (
              <Badge variant="outline" className="ml-auto rounded-md text-[10px] text-warning">
                unsaved changes
              </Badge>
            )}
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="rounded-md">
                read-only
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{clusterId ? "Agent installed read-only (rbac.write=false)" : "Editing not available here"}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {err && (
        <div className="p-2">
          <ErrorCallout title={conflict ? "Field conflict" : "Apply error"} message={err} />
          {conflict && (
            <Callout variant="warning" className="mt-2 py-2">
              <CalloutTitle>Another manager owns some of these fields</CalloutTitle>
              <CalloutDescription>Enable “Force” to take ownership, the same as `kubectl apply --server-side --force-conflicts`.</CalloutDescription>
            </Callout>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor
          value={text}
          readOnly={!editable}
          onChange={(v) => {
            setText(v);
            setDirty(v !== original);
          }}
        />
      </div>

      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="flex h-[80vh] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
            <DialogDescription>
              Left: live object. Right: your edit. {dryRun ? "Dry run validates on the server without persisting." : "Server-side apply with field manager “kmate”."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <CodeDiff original={original} modified={text} />
          </div>
          <DialogFooter className="items-center">
            <Label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={dryRun} onCheckedChange={setDryRun} /> Dry run
            </Label>
            <Button variant="outline" onClick={() => setPreview(false)}>
              Cancel
            </Button>
            <Button onClick={() => void apply()} disabled={busy}>
              {busy ? <Spinner size="sm" /> : <Check />} {dryRun ? "Run dry run" : force ? "Force apply" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
