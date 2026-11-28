import type { ApiProvider, Connection } from "@agent-rishi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingRow, SettingsSection } from "./settings-ui";

const connectionsKey = ["connections"] as const;

/** The providers a connection can use (`docs/foundation.md` §4.1), with their Vault slug. */
export const CONNECTION_PROVIDERS: { id: ApiProvider; label: string; vault: string | null }[] = [
  { id: "anthropic", label: "Anthropic", vault: "anthropic" },
  { id: "openai", label: "OpenAI", vault: "openai" },
  { id: "gemini", label: "Gemini", vault: "gemini" },
  { id: "xai", label: "xAI", vault: "xai" },
  { id: "sarvam-ai", label: "Sarvam AI", vault: "sarvam-ai" },
  { id: "openai-compatible", label: "OpenAI-compatible (local models)", vault: null },
];

const selectClass = "h-8 rounded-md border border-border bg-background px-2 text-xs";

const providerLabel = (p: ApiProvider) => CONNECTION_PROVIDERS.find((x) => x.id === p)?.label ?? p;

function LevelBadge({ c }: { c: Connection }) {
  const [text, tone] =
    c.level === "verified"
      ? ["Verified", "text-status-done"]
      : c.level === "credential_found"
        ? ["Key found, not verified", "text-status-waiting"]
        : ["Not verified", "text-status-waiting"];
  return (
    <span className={cn("shrink-0 text-2xs font-medium", tone)} data-testid="connection-level">
      {text}
    </span>
  );
}

/**
 * Settings › Connections: provider accounts reached with an API key from the Vault, or an
 * OpenAI-compatible server. Each lists its models live; a connection is ready once that list
 * has passed (verified).
 */
export function ConnectionSettings() {
  const client = useClient();
  const list = useQuery({ queryKey: connectionsKey, queryFn: () => client.connections.list() });
  return (
    <>
      <SettingsSection
        title="Connections"
        description="Accounts your agents can run on with an API key, besides each CLI's own sign-in. Models are listed from the provider itself; listing them costs no tokens."
      >
        {list.data?.length === 0 && (
          <div className="px-4 py-3.5 text-[13px] text-muted-foreground">No connections yet.</div>
        )}
        {list.data?.map((c) => (
          <ConnectionRow key={c.id} c={c} />
        ))}
      </SettingsSection>
      <AddConnection />
    </>
  );
}

function ConnectionRow({ c }: { c: Connection }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [manual, setManual] = useState(
    c.models
      .filter((m) => m.manual)
      .map((m) => m.id)
      .join(", "),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: connectionsKey });
  const check = useMutation({
    mutationFn: () => client.connections.check(c.id),
    onSuccess: refresh,
    onError: (e) => toast.error("Check failed", { description: e.message }),
  });
  const saveManual = useMutation({
    mutationFn: () =>
      client.connections.update(c.id, {
        manualModels: manual
          .split(/[\s,]+/)
          .map((m) => m.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      refresh();
      toast.success("Models saved");
    },
    onError: (e) => toast.error("Models not saved", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => client.connections.remove(c.id),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
      toast.success(`${c.name} removed`);
    },
    onError: (e) => toast.error("Not removed", { description: e.message }),
  });
  return (
    <div data-testid="connection">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{c.name}</div>
          <div className="truncate text-2xs text-muted-foreground">
            {providerLabel(c.provider)} · {c.models.length}{" "}
            {c.models.length === 1 ? "model" : "models"}
            {c.lastCheck && ` · ${c.lastCheck.message}`}
          </div>
        </div>
        <LevelBadge c={c} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border bg-background/40 px-4 py-3.5 text-xs">
          {c.lastCheck && (
            <div data-testid="connection-check">
              Last check {new Date(c.lastCheck.at).toLocaleString()}: {c.lastCheck.message}
            </div>
          )}
          {c.baseUrl && <div className="font-mono text-2xs">{c.baseUrl}</div>}
          <div className="flex flex-wrap gap-1.5" data-testid="connection-models">
            {c.models.map((m) => (
              <span key={m.id} className="rounded bg-accent px-1.5 py-0.5 font-mono text-2xs">
                {m.id}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Models added by hand"
              placeholder="Model IDs, if the provider doesn't list them"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              className="h-8 w-80 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={saveManual.isPending}
              onClick={() => saveManual.mutate()}
            >
              Save models
            </Button>
          </div>
          <ChooseKey c={c} onDone={refresh} />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshCw /> Check now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              <Trash2 /> Remove
            </Button>
          </div>
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {c.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its key stays in the Vault; only this connection's grant for it is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The Vault keys a connection may use: API keys for its provider, any for a compatible server. */
function useConnectionKeys(provider: ApiProvider) {
  const client = useClient();
  const items = useQuery({ queryKey: ["vault", "items"], queryFn: () => client.vault.items() });
  const slug = CONNECTION_PROVIDERS.find((p) => p.id === provider)?.vault ?? null;
  return (items.data ?? []).filter(
    (i) => i.kind === "api-credential" && (provider === "openai-compatible" || i.provider === slug),
  );
}

/**
 * Choose a connection's key again, or another: grants it to this connection and checks. This
 * is how a key comes back after its grant was removed in the Vault or the address changed.
 */
function ChooseKey({ c, onDone }: { c: Connection; onDone: () => void }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const keys = useConnectionKeys(c.provider);
  const [choice, setChoice] = useState(c.vaultItemId ?? "");
  const use = useMutation({
    mutationFn: () => client.connections.update(c.id, { vaultItemId: choice || null }),
    onSuccess: (next) => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
      if (next.level === "verified") toast.success(`${next.name} is verified`);
      else toast.warning(`${next.name} not verified`, { description: next.lastCheck?.message });
    },
    onError: (e) => toast.error("Key not used", { description: e.message }),
  });
  if (keys.length === 0 && c.provider !== "openai-compatible") return null;
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Key for this connection"
        className={selectClass}
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        {c.provider === "openai-compatible" && <option value="">No key</option>}
        {keys.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
      </select>
      <Button size="sm" variant="outline" disabled={use.isPending} onClick={() => use.mutate()}>
        Use this key
      </Button>
    </div>
  );
}

function AddConnection() {
  const client = useClient();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [name, setName] = useState("");
  const [vaultItemId, setVaultItemId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const compatible = provider === "openai-compatible";
  const keys = useConnectionKeys(provider);
  const save = useMutation({
    mutationFn: () =>
      client.connections.create({
        name: name.trim() || providerLabel(provider),
        provider,
        vaultItemId: vaultItemId || null,
        baseUrl: baseUrl.trim() || null,
      }),
    onSuccess: (c) => {
      setName("");
      setVaultItemId("");
      setBaseUrl("");
      void queryClient.invalidateQueries({ queryKey: connectionsKey });
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
      if (c.level === "verified")
        toast.success(`${c.name} is verified`, { description: c.lastCheck?.message });
      else toast.warning(`${c.name} saved, not verified`, { description: c.lastCheck?.message });
    },
    onError: (e) => toast.error("Not saved", { description: e.message }),
  });
  const complete = compatible ? baseUrl.trim() !== "" : vaultItemId !== "";
  return (
    <SettingsSection title="Add a connection">
      <SettingRow label="Provider">
        <select
          aria-label="Connection provider"
          className={selectClass}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as ApiProvider);
            setVaultItemId("");
          }}
        >
          {CONNECTION_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Name">
        <Input
          aria-label="Connection name"
          placeholder={providerLabel(provider)}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-60 text-xs"
        />
      </SettingRow>
      <SettingRow
        label="API key"
        help={
          keys.length === 0 ? (
            <>
              No {compatible ? "" : `${providerLabel(provider)} `}key in the Vault yet.{" "}
              <Link to="/settings/$section" params={{ section: "vault" }} className="underline">
                Add one in the Vault
              </Link>
              .
            </>
          ) : (
            "Choosing a key grants it to this connection only; you can see the grant in the Vault."
          )
        }
      >
        <select
          aria-label="Connection key"
          className={selectClass}
          value={vaultItemId}
          onChange={(e) => setVaultItemId(e.target.value)}
        >
          <option value="">{compatible ? "No key" : "Choose a key"}</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Base URL"
        help={
          compatible
            ? "Where the server answers the OpenAI API, e.g. http://127.0.0.1:11434/v1 for Ollama."
            : "Leave empty for the provider's usual address."
        }
      >
        <Input
          aria-label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="h-8 w-72 font-mono text-xs"
        />
      </SettingRow>
      <div className="flex justify-end px-4 py-3">
        <Button size="sm" disabled={!complete || save.isPending} onClick={() => save.mutate()}>
          Save and check
        </Button>
      </div>
    </SettingsSection>
  );
}
