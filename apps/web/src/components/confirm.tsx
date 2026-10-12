import * as React from "react";
import { errorMessage } from "@/api/client";
import { Spinner } from "@/components/spinner";
import { ErrorCallout } from "@/components/status";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/*
 * Adapted from Hirael's `confirm` component. KMate adds two things:
 *  - a failed `onConfirm` shows its error inside the dialog, which stays open,
 *    because a toast behind a modal is easy to miss;
 *  - `typeToConfirm` for the rare actions that are severe and irreversible
 *    (deleting a namespace or node, removing a cluster).
 */

export type ConfirmTone = "default" | "destructive";

export interface ConfirmOptions {
  /** Dialog heading, and the dialog's accessible name. Name the object: "Delete pod api-7f9?". */
  title?: React.ReactNode;
  /** What happens, and whether it can be undone. */
  description?: React.ReactNode;
  /** Confirm button label. Say the outcome ("Delete pod"), never "OK" or "Confirm". */
  confirmText?: React.ReactNode;
  cancelText?: React.ReactNode;
  tone?: ConfirmTone;
  icon?: React.ReactNode;
  /** The user must type this exact text before confirming. Reserve it for severe actions. */
  typeToConfirm?: string;
  /**
   * Runs on confirm. While pending the dialog shows a spinner; if it throws,
   * the error is shown in the dialog and the user can retry or cancel.
   */
  onConfirm?: () => void | Promise<void>;
}

/** Resolves `true` once confirmed (and `onConfirm` succeeded), `false` on cancel. */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");

  return ctx;
}

interface ConfirmRequest {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

const CLOSE_DURATION = 200;

/** Mount once near the root. Calls made while a dialog is open queue behind it. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState("");
  const [active, setActive] = React.useState<ConfirmRequest | null>(null);
  const activeRef = React.useRef<ConfirmRequest | null>(null);
  const queueRef = React.useRef<ConfirmRequest[]>([]);
  const closingRef = React.useRef(false);
  const closeTimerRef = React.useRef<number | undefined>(undefined);
  const typedId = React.useId();

  const show = (request: ConfirmRequest | null) => {
    activeRef.current = request;
    setActive(request);
    setError(null);
    setTyped("");
    setOpen(request !== null);
  };

  const confirm = React.useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      const request: ConfirmRequest = { options, resolve };
      if (activeRef.current) {
        queueRef.current.push(request);

        return;
      }
      show(request);
    });
  }, []);

  const settle = React.useCallback((value: boolean) => {
    const current = activeRef.current;
    if (!current || closingRef.current) return;
    closingRef.current = true;
    current.resolve(value);
    setPending(false);
    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      closingRef.current = false;
      show(queueRef.current.shift() ?? null);
    }, CLOSE_DURATION);
  }, []);

  React.useEffect(
    () => () => {
      window.clearTimeout(closeTimerRef.current);
      activeRef.current?.resolve(false);
      for (const queued of queueRef.current) queued.resolve(false);
      queueRef.current = [];
    },
    [],
  );

  const options = active?.options ?? {};
  const tone = options.tone ?? "default";
  const phrase = options.typeToConfirm;
  const phraseOk = !phrase || typed.trim() === phrase;

  const handleConfirm = () => {
    if (closingRef.current || !phraseOk) return;
    const onConfirm = activeRef.current?.options.onConfirm;
    if (!onConfirm) {
      settle(true);

      return;
    }
    setPending(true);
    setError(null);
    Promise.resolve()
      .then(onConfirm)
      .then(
        () => settle(true),
        (e: unknown) => {
          setPending(false);
          setError(errorMessage(e));
        },
      );
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) settle(false);
        }}
      >
        <AlertDialogContent
          data-tone={tone}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          {...(options.description == null ? { "aria-describedby": undefined } : {})}
        >
          <AlertDialogHeader>
            {options.icon != null && (
              <AlertDialogMedia className={cn(tone === "destructive" && "bg-destructive/10 text-destructive")}>{options.icon}</AlertDialogMedia>
            )}
            <AlertDialogTitle>{options.title ?? "Are you sure?"}</AlertDialogTitle>
            {options.description != null && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          {phrase && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
            >
              <Field>
                <FieldLabel htmlFor={typedId}>
                  Type <span className="font-mono font-semibold">{phrase}</span> to confirm
                </FieldLabel>
                <Input
                  id={typedId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={pending}
                  className="font-mono"
                />
                {!phraseOk && typed.length > 0 && <FieldDescription>The text does not match yet.</FieldDescription>}
              </Field>
            </form>
          )}
          <ErrorCallout message={error} title="That did not work" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{options.cancelText ?? "Cancel"}</AlertDialogCancel>
            <Button type="button" variant={tone === "destructive" ? "destructive" : "default"} disabled={pending || !phraseOk} onClick={handleConfirm}>
              {pending && <Spinner size="sm" />}
              {options.confirmText ?? "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
