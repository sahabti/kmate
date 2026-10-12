import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, RotateCw, Search } from "lucide-react";
import { cluster, errorMessage } from "@/api/client";
import { ErrorCallout } from "@/components/status";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const MAX_LINES = 20_000;

export function LogsView({ clusterId, namespace, pod, containers }: { clusterId: string; namespace: string; pod: string; containers: string[] }) {
  const [container, setContainer] = useState(containers[0] ?? "");
  const [paused, setPaused] = useState(false);
  /** Lines that arrived while paused; shown when the user resumes. */
  const held = useRef<string[]>([]);
  const pausedRef = useRef(false);
  const [heldCount, setHeldCount] = useState(0);
  const [tail, setTail] = useState(500);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [gen, setGen] = useState(0);
  const boxRef = useRef<HTMLPreElement>(null);
  const autoScroll = useRef(true);

  const push = (parts: string[]) => {
    if (pausedRef.current) {
      held.current.push(...parts);
      setHeldCount(held.current.length);
      return;
    }
    setLines((prev) => [...prev, ...parts].slice(-MAX_LINES));
  };

  const togglePause = () => {
    if (pausedRef.current) {
      const parts = held.current;
      held.current = [];
      setHeldCount(0);
      autoScroll.current = true;
      setLines((prev) => [...prev, ...parts].slice(-MAX_LINES));
    }
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };

  // Pausing freezes what is on screen; the stream keeps running so nothing is lost.
  useEffect(() => {
    setLines([]);
    held.current = [];
    setHeldCount(0);
    setError(null);
    const ac = new AbortController();
    let buf = "";
    const dec = new TextDecoder();
    (async () => {
      try {
        const stream = cluster.logs({ clusterId, logs: { namespace, pod, container, follow: true, tailLines: BigInt(tail), timestamps, previous } }, { signal: ac.signal });
        for await (const d of stream) {
          buf += dec.decode(d.bytes, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          if (parts.length) push(parts);
          if (d.eof) break;
        }
        if (buf) push([buf]);
      } catch (e) {
        if (!ac.signal.aborted) setError(errorMessage(e));
      }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push reads refs only
  }, [clusterId, namespace, pod, container, tail, timestamps, previous, gen]);

  useEffect(() => {
    if (autoScroll.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const shown = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines), [lines, q]);

  const download = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${pod}-${container}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-xs">
        <Select value={container} onValueChange={setContainer}>
          <SelectTrigger size="sm" className="max-w-44 font-mono text-xs" aria-label="Container">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {containers.map((c) => (
              <SelectItem key={c} value={c} className="font-mono text-xs">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup type="single" size="sm" variant="outline" value={String(tail)} onValueChange={(v) => v && setTail(Number(v))} aria-label="Tail lines">
          {[100, 500, 2000, 10000].map((n) => (
            <ToggleGroupItem key={n} value={String(n)} className="px-2 font-mono text-[11px]">
              {n >= 1000 ? `${n / 1000}k` : n}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Label htmlFor="log-ts" className="flex items-center gap-1.5 text-muted-foreground">
          <Switch id="log-ts" size="sm" checked={timestamps} onCheckedChange={setTimestamps} /> Timestamps
        </Label>
        <Label htmlFor="log-prev" className="flex items-center gap-1.5 text-muted-foreground">
          <Switch id="log-prev" size="sm" checked={previous} onCheckedChange={setPrevious} /> Previous
        </Label>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant={paused ? "secondary" : "outline"} onClick={togglePause} aria-pressed={paused}>
                {paused ? <Play /> : <Pause />} {paused ? (heldCount ? `Resume (${heldCount} new)` : "Resume") : "Pause"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{paused ? "Show the lines that arrived while paused" : "Freeze the output; new lines are kept"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={() => setGen((g) => g + 1)} aria-label="Reload">
                <RotateCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={download} aria-label="Download">
                <Download />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download log</TooltipContent>
          </Tooltip>
        </div>
        <InputGroup className="h-7 w-full sm:ml-auto sm:w-44">
          <InputGroupAddon>
            <Search className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search…" aria-label="Search log lines" value={q} onChange={(e) => setQ(e.target.value)} className="text-xs" />
        </InputGroup>
      </div>
      {error && (
        <div className="p-2">
          <ErrorCallout message={error} />
        </div>
      )}
      <pre
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto bg-[oklch(0.13_0.012_250)] p-3 text-[11.5px] leading-[1.45] break-all whitespace-pre-wrap text-[oklch(0.9_0.01_240)]"
      >
        {shown.length === 0 ? <span className="text-muted-foreground">{lines.length === 0 ? "No log output yet…" : "No lines match"}</span> : shown.join("\n")}
      </pre>
      <div className="border-t px-3 py-1 font-mono text-[10px] text-muted-foreground">
        {shown.length} / {lines.length} lines
      </div>
    </div>
  );
}
