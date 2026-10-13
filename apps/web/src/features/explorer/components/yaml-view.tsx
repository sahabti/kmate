import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import yaml from "js-yaml";
import { Check, FileDiff, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { cluster, errorMessage } from "@/services/api-client";
import { CodeDiff, CodeEditor } from "@/features/explorer/components/code-editor";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { Spinner } from "@/components/spinner";
import { ErrorCallout } from "@/components/status";
import { ToneBadge } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { decodeObject, type KObj } from "@/lib/k8s";
import { applyBody, editVersion } from "@/features/explorer/lib/yaml-edit";

const DUMP = { noRefs: true, lineWidth: 120, sortKeys: false } as const;

interface YamlViewProps {
  obj: KObj;
  clusterId?: string;
  canWrite?: boolean;
  onApplied?: (updated: KObj) => void;
}

/**
 * YAML tab: editable Monaco editor with diff preview + server-side apply.
 * Read-only when the agent lacks the "write" capability.
 */
export const YamlView = ({ obj, clusterId, canWrite, onApplied }: YamlViewProps) => {
  const liveYaml = useMemo(() => yaml.dump(obj, DUMP), [obj]);
  const [draft, setDraft] = useState(liveYaml);
  const [draftBase, setDraftBase] = useState<KObj | null>(null);
  const [dirty, setDirty] = useState(false);
  const baseObj = dirty ? draftBase ?? obj : obj;
  const original = useMemo(() => yaml.dump(baseObj, DUMP), [baseObj]);
  const [dryRun, setDryRun] = useState(false);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const qc = useQueryClient();

  // Until the user edits, follow the live object so a refresh shows the new version.
  const text = dirty ? draft : original;

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

  // Parse before opening the review, so a YAML mistake shows next to the editor
  // instead of behind the dialog.
  const review = () => {
    setErr(null);
    if (parse()) setPreview(true);
  };

  const apply = async () => {
    const doc = parse();
    if (!doc || !clusterId) return;
    const body = applyBody(doc);
    setBusy(true);
    setErr(null);
    try {
      const json = new TextEncoder().encode(JSON.stringify(body));
      const result = await cluster.apply({
        clusterId,
        apply: {
          object: { json, apiVersion: body.apiVersion ?? "", kind: body.kind ?? "", namespace: body.metadata?.namespace ?? "", name: body.metadata?.name ?? "", resourceVersion: editVersion(baseObj) },
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
        setDraftBase(null);
        // The informer may briefly lag the write response. Show the accepted
        // object immediately instead of refetching an older cached version.
        if (result.object && onApplied) onApplied(decodeObject(result.object.json));
        else await qc.invalidateQueries({ queryKey: ["object", clusterId] });
      }
    } catch (e) {
      // Shown inside the review dialog, which stays open so the edit can be retried.
      const m = errorMessage(e);
      setErr(m);
      setConflict(obj.kind !== "Secret" && obj.kind !== "ConfigMap" && /conflict/i.test(m));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
        {editable ? (
          <>
            <Button size="sm" variant="outline" disabled={!dirty} onClick={review}>
              <FileDiff /> Diff
            </Button>
            <Button size="sm" disabled={!dirty || busy} onClick={review}>
              {busy ? <Spinner size="sm" /> : <Save />} {dryRun ? "Dry run" : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(original);
                setDirty(false);
                setDraftBase(null);
                setErr(null);
                setConflict(false);
              }}
            >
              <RotateCcw /> Reset
            </Button>
            <label className="ml-1 flex items-center gap-1.5 text-muted-foreground">
              <Switch size="sm" checked={dryRun} onCheckedChange={setDryRun} aria-label="Dry run" /> Dry run
            </label>
            {dirty && (
              <ToneBadge tone="warn" className="ml-auto">
                unsaved changes
              </ToneBadge>
            )}
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary">
                read-only
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{clusterId ? "Agent installed read-only (rbac.write=false)" : "Editing not available here"}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {err && !preview && (
        <div className="p-2">
          <ErrorCallout title="Invalid YAML" message={err} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor
          value={text}
          readOnly={!editable}
          onChange={(v) => {
            if (!dirty) setDraftBase(obj);
            setDraft(v);
            setDirty(v !== original);
          }}
        />
      </div>

      <Dialog
        open={preview}
        onOpenChange={(o) => {
          setPreview(o);
          if (!o) setErr(null);
        }}
      >
        <DialogContent className="flex h-[80vh] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
            <DialogDescription>
              Left: object before editing. Right: your edit. {dryRun ? "Dry run validates on the server without persisting." : obj.kind === "Secret" || obj.kind === "ConfigMap" ? "Saving applies additions, changes, and removals. Concurrent changes require a reload." : "Server-side apply with field manager “kmate”."}
            </DialogDescription>
          </DialogHeader>
          {err && (
            <div className="flex flex-col gap-2">
              <ErrorCallout title={conflict ? "Field conflict" : dryRun ? "Dry run failed" : "Apply failed"} message={err} />
              {conflict && (
                <Callout variant="warning" className="py-2">
                  <CalloutTitle>Another manager owns some of these fields</CalloutTitle>
                  <CalloutDescription className="flex flex-col gap-2">
                    Take ownership to apply anyway, the same as `kubectl apply --server-side --force-conflicts`.
                    <Label>
                      <Switch size="sm" checked={force} onCheckedChange={setForce} /> Force (take field ownership)
                    </Label>
                  </CalloutDescription>
                </Callout>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <CodeDiff original={original} modified={text} />
          </div>
          <DialogFooter className="items-center">
            <Label className="mr-auto">
              <Switch size="sm" checked={dryRun} onCheckedChange={setDryRun} /> Dry run
            </Label>
            <Button
              variant="outline"
              onClick={() => {
                setPreview(false);
                setErr(null);
              }}
            >
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
};
