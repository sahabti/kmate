import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ClipboardPaste, Copy, RotateCw, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import { wsUrl } from "@/api/client";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { KbdButton } from "@/components/kbd";
import { Dot, type Tone } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/store/theme";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/ash", "/bin/zsh"];
const CUSTOM = "__custom__";

/**
 * Exec terminal. WebSocket framing:
 *  client -> server: [0x00, ...stdin bytes] | [0xFF, ...JSON {cols,rows}] (resize)
 *  server -> client: [0x01, ...stdout] | [0x02, ...stderr] | [0x03, ...error/exit text]
 */
export default function ExecTerminal({ clusterId, namespace, pod, containers, canExec = true }: { clusterId: string; namespace: string; pod: string; containers: string[]; canExec?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [container, setContainer] = useState(containers[0] ?? "");
  const [shellSel, setShellSel] = useState(SHELLS[0]!);
  const [custom, setCustom] = useState("");
  const [gen, setGen] = useState(0);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [ctrl, setCtrl] = useState(false);
  const theme = useTheme((s) => s.theme);
  const shell = shellSel === CUSTOM ? custom.trim() || "/bin/sh" : shellSel;
  const command = shell.split(/\s+/).filter(Boolean);

  useEffect(() => {
    if (!ref.current || !canExec) return;
    // Defer the heavy setup one frame: React StrictMode (and fast tab flips)
    // mount → unmount → mount synchronously, and xterm schedules viewport work
    // that throws if the terminal was disposed in between.
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled || !ref.current) return;
      cleanup = setup();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, namespace, pod, container, shell, gen, canExec, theme]);

  function setup(): () => void {
    const host = ref.current!;
    const dark = theme === "dark";
    const term = new XTerm({
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: dark ? { background: "#0f141b", foreground: "#e2e8f0" } : { background: "#ffffff", foreground: "#0f172a", cursor: "#0f172a" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const safeFit = () => {
      const el = ref.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0 || !term.element) return;
      try {
        fit.fit();
      } catch {
        /* terminal disposed mid-resize */
      }
    };
    safeFit();
    termRef.current = term;

    const ws = new WebSocket(wsUrl(`/ws/clusters/${clusterId}/exec`, { namespace, pod, container, cmd: command, tty: "1", cols: String(term.cols), rows: String(term.rows) }));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let disposed = false; // frames can still arrive after the terminal is torn down
    const send = (ch: number, payload: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const buf = new Uint8Array(payload.length + 1);
      buf[0] = ch;
      buf.set(payload, 1);
      ws.send(buf);
    };
    const sendResize = () => send(0xff, enc.encode(JSON.stringify({ cols: term.cols, rows: term.rows })));
    ws.onopen = () => {
      setStatus("open");
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (disposed) return;
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (data.length === 0) return;
      const ch = data[0];
      const body = data.subarray(1);
      if (ch === 1 || ch === 2) term.write(body);
      else if (ch === 3) term.write(`\r\n\x1b[33m${dec.decode(body)}\x1b[0m\r\n`);
    };
    ws.onclose = (ev) => {
      setStatus("closed");
      if (disposed) return;
      term.write(`\r\n\x1b[90m[connection closed${ev.reason ? `: ${ev.reason}` : ""}]\x1b[0m\r\n`);
    };
    ws.onerror = () => setStatus("closed");
    const sub = term.onData((d) => send(0x00, enc.encode(d)));
    // Ctrl/Cmd+Shift+C copies the selection, Ctrl/Cmd+Shift+V pastes (xterm otherwise swallows them).
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.type === "keydown") {
        if (e.key.toLowerCase() === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (e.key.toLowerCase() === "v") {
          void navigator.clipboard.readText().then((t) => t && send(0x00, enc.encode(t)));
          return false;
        }
      }
      return true;
    });
    const ro = new ResizeObserver(() => {
      safeFit();
      sendResize();
    });
    ro.observe(host);
    return () => {
      disposed = true;
      ro.disconnect();
      sub.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }


  const sendText = (t: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(t);
    const buf = new Uint8Array(payload.length + 1);
    buf[0] = 0x00;
    buf.set(payload, 1);
    ws.send(buf);
    termRef.current?.focus();
  };
  const softKey = (k: string) => {
    if (k === "Ctrl") return setCtrl((c) => !c);
    const map: Record<string, string> = { Tab: "\t", Esc: "\x1b", "↑": "\x1b[A", "↓": "\x1b[B", "←": "\x1b[D", "→": "\x1b[C", Home: "\x1b[H", End: "\x1b[F" };
    let v = map[k] ?? k;
    if (ctrl && k.length === 1) {
      v = String.fromCharCode(k.toUpperCase().charCodeAt(0) - 64);
      setCtrl(false);
    }
    sendText(v);
  };

  if (!canExec) {
    return (
      <div className="p-4">
        <Callout variant="warning">
          <CalloutTitle>Terminal disabled on this cluster</CalloutTitle>
          <CalloutDescription>
            The agent was installed without exec permissions. Re-install with <code className="font-mono">--set rbac.exec=true</code> (Helm) or <code className="font-mono">KMATE_CAN_EXEC=true</code> (local agent) to enable pods/exec.
          </CalloutDescription>
        </Callout>
      </div>
    );
  }

  const tone: Tone = status === "open" ? "ok" : status === "connecting" ? "warn" : "bad";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
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
        <Select value={shellSel} onValueChange={setShellSel}>
          <SelectTrigger size="sm" className="font-mono text-xs" aria-label="Shell">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHELLS.map((s) => (
              <SelectItem key={s} value={s} className="font-mono text-xs">
                {s}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM} className="text-xs">
              Custom command…
            </SelectItem>
          </SelectContent>
        </Select>
        {shellSel === CUSTOM && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setGen((g) => g + 1);
            }}
          >
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="/usr/bin/python3 -i" className="h-8 w-52 font-mono text-xs" aria-label="Custom command" />
          </form>
        )}
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Dot tone={tone} pulse={status === "connecting"} /> {status}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Copy selection" onClick={() => {
                const t = termRef.current;
                if (t?.hasSelection()) {
                  void navigator.clipboard.writeText(t.getSelection());
                  toast.success("Copied selection");
                } else toast.info("Select text in the terminal first");
              }}>
                <Copy />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy selection (Ctrl/⌘+Shift+C)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Paste" onClick={() => void navigator.clipboard.readText().then((t) => t && sendText(t)).catch(() => toast.error("Clipboard access denied"))}>
                <ClipboardPaste />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Paste (Ctrl/⌘+Shift+V)</TooltipContent>
          </Tooltip>
          <Button size="sm" variant="outline" onClick={() => setGen((g) => g + 1)}>
            <RotateCw /> Reconnect
          </Button>
        </div>
      </div>
      <div ref={ref} className={theme === "dark" ? "min-h-0 flex-1 bg-[#0f141b] p-1" : "min-h-0 flex-1 bg-white p-1"} />
      {/* Soft keyboard helper bar for mobile */}
      <div className="flex gap-1 overflow-x-auto border-t p-1.5 md:hidden">
        {["Tab", "Esc", "Ctrl", "c", "d", "←", "→", "↑", "↓", "|", "-", "/", "~"].map((k) => (
          <KbdButton key={k} className={k === "Ctrl" && ctrl ? "h-7 min-w-9 bg-primary text-primary-foreground text-xs" : "h-7 min-w-9 text-xs"} onClick={() => softKey(k)}>
            {k}
          </KbdButton>
        ))}
      </div>
      <div className="hidden items-center gap-1 border-t px-3 py-1 text-[10px] text-muted-foreground md:flex">
        <TerminalSquare className="size-3" /> {command.join(" ")} in {container} · {pod}
      </div>
    </div>
  );
}
