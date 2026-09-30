import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, Waypoints } from "lucide-react";
import { hub, errorMessage } from "@/api/client";
import { PasswordInput, PasswordInputField } from "@/components/password-input";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";

const ENTER = "animate-in fade-in slide-in-from-bottom-4 duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] fill-mode-both motion-reduce:animate-none";
const SWAP = "animate-in fade-in slide-in-from-bottom-1 duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] fill-mode-both motion-reduce:animate-none";
const stagger = (index: number): React.CSSProperties => ({ animationDelay: `${index * 60}ms` });

/** Login page adapted from Hirael's login-01 block. */
export function LoginPage() {
  const nav = useNavigate();
  const setSession = useSession((s) => s.setSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await hub.login({ email, password });
      if (!res.user) throw new Error("no user in response");
      setSession(res.token, res.user);
      void nav({ to: "/" });
    } catch (e) {
      setErr(errorMessage(e));
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="relative isolate flex min-h-full items-center justify-center bg-background px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-size-[32px_32px] opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]"
      />
      <div className="w-full max-w-sm">
        <div className={cn(ENTER, "rounded-lg border bg-card shadow-[6px_6px_0_0_var(--border)]")}>
          <div className="flex flex-col items-center gap-3 border-b px-8 pt-8 pb-6">
            <div className={cn(ENTER, "flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground")}>
              <Waypoints className="size-5" />
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <h1 style={stagger(1)} className={cn(ENTER, "text-2xl font-semibold tracking-tight")}>
                KMate
              </h1>
              <p style={stagger(2)} className={cn(ENTER, "text-xs text-muted-foreground")}>
                Sign in to your hub to continue.
              </p>
            </div>
          </div>

          <form noValidate style={stagger(3)} className={cn(ENTER, "p-8")} onSubmit={submit}>
            <FieldGroup className="gap-5">
              {err && (
                <div key={attempt} role="alert" className={cn(SWAP, "flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive")}>
                  <CircleAlert aria-hidden className="size-3.5 shrink-0" />
                  <span className="break-words">{err}</span>
                </div>
              )}
              <Field className="gap-1.5">
                <FieldLabel htmlFor="login-email">Email</FieldLabel>
                <Input id="login-email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <PasswordInput id="login-password" value={password} onValueChange={setPassword}>
                  <PasswordInputField placeholder="••••••••" autoComplete="current-password" />
                </PasswordInput>
              </Field>
              <Button type="submit" size="lg" disabled={busy || !email || !password} className="group">
                {busy ? (
                  <>
                    <Spinner size="sm" /> Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="size-4 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
                  </>
                )}
              </Button>
            </FieldGroup>
          </form>

          <div className="border-t px-8 py-3 text-center">
            <p className="text-[11px] text-muted-foreground">
              Dev default: <span className="font-mono">admin@kmate.local</span> / <span className="font-mono">admin</span>
            </p>
          </div>
        </div>
        <p style={stagger(5)} className={cn(ENTER, "mt-4 text-center text-[11px] tracking-wide text-muted-foreground uppercase")}>
          Agent-based · no kubeconfig on this device
        </p>
      </div>
    </section>
  );
}
