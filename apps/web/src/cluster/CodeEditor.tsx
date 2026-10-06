import { useEffect, useState } from "react";
import Editor, { DiffEditor, loader } from "@monaco-editor/react";
// The package exports map rewrites subpaths, so "monaco-editor/editor/..." is the
// published spelling for ./esm/vs/editor/...
// Only the editor core: importing the package root would also pull every
// language contribution and its worker (TypeScript, CSS, HTML, JSON), ~9 MB we
// do not use for YAML.
import * as monaco from "monaco-editor/editor/editor.api";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import { useTheme } from "@/store/theme";

/**
 * Monaco is bundled with the app rather than pulled from a CDN.
 *
 * @monaco-editor/react fetches the editor from jsdelivr by default, which hangs
 * forever in an air-gapped or egress-restricted cluster: exactly the failure
 * other Kubernetes dashboards hit with CDN-loaded plugins. Everything below is
 * served from our own origin.
 */
self.MonacoEnvironment = {
  // YAML and JSON need only the basic worker; no language services are loaded.
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

const OPTIONS = { minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: "on" as const, renderLineHighlight: "none" as const, tabSize: 2, automaticLayout: true };

/** Resolves once Monaco has initialised, so callers never see a blank editor. */
function useMonacoReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loader.init().then(
      () => alive && setReady(true),
      () => alive && setReady(true), // show the editor anyway; it reports its own failure
    );
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

/** Monaco wrapper (lazy-loaded by callers). */
export default function CodeEditor({ value, language = "yaml", readOnly = false, onChange, height = "100%" }: { value: string; language?: string; readOnly?: boolean; onChange?: (v: string) => void; height?: string }) {
  const theme = useTheme((s) => s.theme);
  const ready = useMonacoReady();
  if (!ready) return <div className="p-3 text-xs text-muted-foreground">Loading editor…</div>;
  return (
    <Editor
      height={height}
      language={language}
      value={value}
      theme={theme === "dark" ? "vs-dark" : "light"}
      onChange={(v) => onChange?.(v ?? "")}
      options={{ ...OPTIONS, readOnly, renderLineHighlight: readOnly ? "none" : "line" }}
      loading={<div className="p-3 text-xs text-muted-foreground">Loading editor…</div>}
    />
  );
}

export function CodeDiff({ original, modified, language = "yaml", height = "100%" }: { original: string; modified: string; language?: string; height?: string }) {
  const theme = useTheme((s) => s.theme);
  const ready = useMonacoReady();
  if (!ready) return <div className="p-3 text-xs text-muted-foreground">Loading diff…</div>;
  return (
    <DiffEditor
      height={height}
      language={language}
      original={original}
      modified={modified}
      theme={theme === "dark" ? "vs-dark" : "light"}
      // Keep the models alive across unmount: the wrapper otherwise disposes them
      // before the diff widget resets, which throws in the console.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      options={{ ...OPTIONS, readOnly: true, renderSideBySide: true, ignoreTrimWhitespace: false }}
      loading={<div className="p-3 text-xs text-muted-foreground">Loading diff…</div>}
    />
  );
}
