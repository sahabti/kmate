import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { hub, errorMessage } from "@/services/api-client";
import { useGrants } from "@/hooks/use-grants";
import { HubShell, initials } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Spinner } from "@/components/spinner";
import { ErrorCallout, PanelSkeleton } from "@/components/status";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { platform } from "@/platform/platform";
import { useSession } from "@/stores/session";
import { useTheme } from "@/stores/theme";

const MIN_PASSWORD = 8;

type ThemeChoice = ReturnType<typeof useTheme.getState>["theme"];

interface SectionProps {
  title: string;
  description: ReactNode;
  children: ReactNode;
}

/** One settings section: what it is on the left, the content on the right. */
const Section = ({ title, description, children }: SectionProps) => {
  return (
    <section className="grid gap-4 py-8 first:pt-0 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-10">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
};

export const SettingsPage = () => {
  return (
    <HubShell>
      <PageHeader title="Settings" description="Your profile, your cluster access, and how KMate looks on this device." />
      <div className="flex flex-col">
        <ProfileSection />
        <Separator />
        <AccessSection />
        <Separator />
        <PasswordSection />
        <Separator />
        <AppearanceSection />
      </div>
    </HubShell>
  );
};

const ProfileSection = () => {
  const user = useSession((s) => s.user);

  return (
    <Section title="Profile" description="Who you are signed in as.">
      <div className="flex items-center gap-4">
        <Avatar className="size-12">
          <AvatarFallback>{initials(user?.name || user?.email)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{user?.name || user?.email}</span>
            <Badge variant="secondary">{user?.role}</Badge>
          </div>
          <span className="truncate text-sm text-muted-foreground">{user?.email}</span>
          <span className="truncate text-xs text-muted-foreground">
            Signed in to <span className="font-mono">{platform.hubUrl()}</span>
          </span>
        </div>
      </div>
    </Section>
  );
};

const AccessSection = () => {
  const isAdmin = useSession((s) => s.user?.role) === "admin";
  const grants = useGrants("");

  return (
    <Section
      title="Cluster access"
      description="Which clusters KMate lets you reach. Inside a cluster, its own RBAC decides what you may actually do."
    >
      {grants.isLoading && <PanelSkeleton lines={2} />}
      <ErrorCallout message={grants.error ? errorMessage(grants.error) : null} />
      {grants.data && grants.data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {isAdmin ? "You are an administrator, so you reach every cluster." : "You have no cluster access yet. Ask an administrator for a grant."}
        </p>
      )}
      {grants.data && grants.data.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {grants.data.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{g.clusterName || g.clusterId}</span>
                <span className="truncate text-xs text-muted-foreground">{g.namespaces.length ? g.namespaces.join(", ") : "All namespaces"}</span>
              </div>
              <Badge variant="outline">{g.role}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const PasswordSection = () => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  // Errors show only after the first submit, then update as the user types.
  const errors = {
    current: !current ? "Enter your current password." : null,
    next: next.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : null,
    again: again !== next ? "The passwords do not match." : null,
  };
  const show = (k: keyof typeof errors) => (submitted ? errors[k] : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setErr(null);
    if (errors.current || errors.next || errors.again) {
      const first = errors.current ? "current" : errors.next ? "next" : "again";
      document.getElementById(`${id}-${first}`)?.focus();

      return;
    }
    setBusy(true);
    try {
      await hub.setPassword({ currentPassword: current, newPassword: next });
      toast.success("Password changed");
      setCurrent("");
      setNext("");
      setAgain("");
      setSubmitted(false);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof typeof errors, label: string, value: string, set: (v: string) => void, autoComplete: string, hint?: string) => (
    <Field data-invalid={!!show(k) || undefined}>
      <FieldLabel htmlFor={`${id}-${k}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${k}`}
        type="password"
        value={value}
        onChange={(e) => set(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={!!show(k) || undefined}
        aria-describedby={show(k) ? `${id}-${k}-error` : undefined}
      />
      {show(k) ? <FieldError id={`${id}-${k}-error`}>{show(k)}</FieldError> : hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );

  return (
    <Section title="Password" description="Change the password you use to sign in to this hub.">
      <form noValidate onSubmit={submit} className="flex max-w-md flex-col gap-6">
        <FieldGroup>
          {field("current", "Current password", current, setCurrent, "current-password")}
          {field("next", "New password", next, setNext, "new-password", `At least ${MIN_PASSWORD} characters.`)}
          {field("again", "Confirm new password", again, setAgain, "new-password")}
        </FieldGroup>
        <ErrorCallout message={err} title="Could not change the password" />
        <div>
          <Button type="submit" disabled={busy}>
            {busy && <Spinner size="sm" />} Change password
          </Button>
        </div>
      </form>
    </Section>
  );
};

const AppearanceSection = () => {
  const { theme, setTheme } = useTheme();

  return (
    <Section title="Appearance" description="Saved on this device only.">
      <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as ThemeChoice)} aria-label="Theme">
        <ToggleGroupItem value="light">
          <Sun /> Light
        </ToggleGroupItem>
        <ToggleGroupItem value="dark">
          <Moon /> Dark
        </ToggleGroupItem>
      </ToggleGroup>
    </Section>
  );
};
