import Editor, { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "@/store/theme";

const OPTIONS = { minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: "on" as const, renderLineHighlight: "none" as const, tabSize: 2, automaticLayout: true };

/** Monaco wrapper (lazy-loaded by callers). */
export default function CodeEditor({ value, language = "yaml", readOnly = false, onChange, height = "100%" }: { value: string; language?: string; readOnly?: boolean; onChange?: (v: string) => void; height?: string }) {
  const theme = useTheme((s) => s.theme);
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
