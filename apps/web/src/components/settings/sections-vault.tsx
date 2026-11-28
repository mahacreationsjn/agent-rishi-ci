import type {
  CreateVaultItemRequest,
  VaultAuditAction,
  VaultGrant,
  VaultItem,
} from "@agent-rishi/contracts";
import { VAULT_VALUE_MIN } from "@agent-rishi/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileUp, KeyRound, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";
import { Segmented, SettingRow, SettingsSection } from "./settings-ui";

const vaultKey = ["vault"] as const;

/** Providers an API key can be for (`docs/foundation.md` §4.1). */
export const VAULT_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Gemini" },
  { id: "xai", label: "xAI" },
  { id: "sarvam-ai", label: "Sarvam AI" },
  { id: "local", label: "Local models" },
] as const;

const ROLES = ["agent", "pm", "orchestrator"] as const;

const EXPIRY = [
  { id: "never", label: "No end", ms: null },
  { id: "1d", label: "1 day", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;

const ACTIONS: Record<VaultAuditAction, string> = {
  "item.created": "Saved",
  "item.imported": "Imported",
  "item.renamed": "Renamed",
  "item.value_changed": "Value replaced",
  "item.deleted": "Deleted",
  "grant.created": "Granted",
  "grant.revoked": "Grant removed",
  "item.used": "Used",
  "item.use_refused": "Use refused",
};

const selectClass = "h-8 rounded-md border border-border bg-background px-2 text-xs";

function useVaultInvalidate() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: vaultKey });
}

function itemSummary(item: VaultItem): string {
  if (item.kind === "env-secret") return `Environment variable · ${item.envName}`;
  const provider = VAULT_PROVIDERS.find((p) => p.id === item.provider)?.label ?? item.provider;
  return `API key · ${provider}`;
}

/**
 * Settings › Vault: the secrets agents use (`docs/foundation.md` §3). Values go to the server
 * and are never shown again; grants say where Agent Rishi may apply them without asking.
 */
export function VaultSettings() {
  const client = useClient();
  const status = useQuery({
    queryKey: [...vaultKey, "status"],
    queryFn: () => client.vault.status(),
  });
  const items = useQuery({ queryKey: [...vaultKey, "items"], queryFn: () => client.vault.items() });
  const ready = status.data?.state === "ready";
  return (
    <>
      <SettingsSection
        title="Vault"
        description="Secrets your agents use. Agent Rishi applies a value where you've granted it; the model never sees it, and Agent Rishi hides it in transcripts. A saved value can't be shown again."
      >
        {status.data && !ready && (
          <div
            className="px-4 py-3.5 text-[13px] text-status-waiting"
            role="alert"
            data-testid="vault-status"
          >
            <div className="font-medium">
              {status.data.state === "locked" ? "The Vault is locked" : "The Vault is unavailable"}
            </div>
            <div className="mt-0.5 text-2xs leading-relaxed">{status.data.reason}</div>
          </div>
        )}
        {items.data?.length === 0 && (
          <div className="px-4 py-3.5 text-[13px] text-muted-foreground">No secrets yet.</div>
        )}
        {items.data?.map((item) => (
          <VaultItemRow key={item.id} item={item} ready={ready} />
        ))}
      </SettingsSection>
      {ready && <AddSecret />}
      {ready && <ImportEnv />}
      <VaultActivity />
    </>
  );
}

function VaultItemRow({ item, ready }: { item: VaultItem; ready: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="vault-item">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{item.name}</div>
          <div className="text-2xs text-muted-foreground">
            {itemSummary(item)}
            {item.lastUsedAt && ` · last used ${new Date(item.lastUsedAt).toLocaleString()}`}
          </div>
        </div>
        {!item.readable && ready && (
          <span className="text-2xs text-status-waiting">Can't be decrypted</span>
        )}
      </button>
      {open && <VaultItemDetails item={item} ready={ready} />}
    </div>
  );
}

function VaultItemDetails({ item, ready }: { item: VaultItem; ready: boolean }) {
  const client = useClient();
  const invalidate = useVaultInvalidate();
  const [name, setName] = useState(item.name);
  const [value, setValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const rename = useMutation({
    mutationFn: () => client.vault.update(item.id, { name: name.trim() }),
    onSuccess: () => {
      invalidate();
      toast.success("Renamed");
    },
    onError: (e) => toast.error("Not renamed", { description: e.message }),
  });
  const replace = useMutation({
    mutationFn: () => client.vault.update(item.id, { value }),
    onSuccess: () => {
      setValue("");
      invalidate();
      toast.success(`New value saved for ${item.name}`);
    },
    onError: (e) => toast.error("Value not saved", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => client.vault.remove(item.id),
    onSuccess: () => {
      invalidate();
      toast.success(`${item.name} deleted`);
    },
    onError: (e) => toast.error("Not deleted", { description: e.message }),
  });
  return (
    <div className="space-y-3 border-t border-border bg-background/40 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-60 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!name.trim() || name.trim() === item.name || rename.isPending}
          onClick={() => rename.mutate()}
        >
          Rename
        </Button>
      </div>
      {ready && (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label="New value"
            placeholder="Paste a new value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-60 font-mono text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={value.length < VAULT_VALUE_MIN || replace.isPending}
            onClick={() => replace.mutate()}
          >
            <KeyRound /> Replace value
          </Button>
        </div>
      )}
      <Grants item={item} />
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        <Trash2 /> Delete
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {item.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its value and grants are removed for good; sessions can't use it any more. Its
              activity stays in the log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function grantLabel(g: VaultGrant, projectName: (id: string) => string): string {
  const parts = [
    g.role ? `role ${g.role}` : "any role",
    g.projectId ? projectName(g.projectId) : "any project",
    g.destination ?? "any destination",
  ];
  if (g.expiresAt) parts.push(`until ${new Date(g.expiresAt).toLocaleString()}`);
  return parts.join(" · ");
}

function Grants({ item }: { item: VaultItem }) {
  const client = useClient();
  const invalidate = useVaultInvalidate();
  const projects = useSnapshotData((s) => s.projects, []);
  const grants = useQuery({
    queryKey: [...vaultKey, "grants", item.id],
    queryFn: () => client.vault.grants(item.id),
  });
  const [role, setRole] = useState("");
  const [projectId, setProjectId] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]["id"]>("never");
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const add = useMutation({
    mutationFn: () => {
      const ms = EXPIRY.find((e) => e.id === expiry)?.ms ?? null;
      return client.vault.grant({
        itemId: item.id,
        role: role || null,
        projectId: projectId || null,
        expiresAt: ms === null ? null : new Date(Date.now() + ms).toISOString(),
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Granted");
    },
    onError: (e) => toast.error("Not granted", { description: e.message }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.vault.revoke(id),
    onSuccess: invalidate,
    onError: (e) => toast.error("Grant not removed", { description: e.message }),
  });
  return (
    <div className="space-y-2">
      <div className="text-2xs font-medium text-muted-foreground">
        Grants: where it is applied without asking
      </div>
      {grants.data?.length === 0 && (
        <div className="text-2xs text-muted-foreground">
          None yet. A session that needs it will have to ask.
        </div>
      )}
      {grants.data?.map((g) => (
        <div key={g.id} className="flex items-center gap-2 text-xs" data-testid="vault-grant">
          <span className="min-w-0 flex-1 truncate">{grantLabel(g, projectName)}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove grant"
            onClick={() => revoke.mutate(g.id)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Grant role"
          className={selectClass}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">Any role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          aria-label="Grant project"
          className={selectClass}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Any project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Grant ends"
          className={selectClass}
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as typeof expiry)}
        >
          {EXPIRY.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate()}>
          Grant
        </Button>
      </div>
    </div>
  );
}

function AddSecret() {
  const client = useClient();
  const invalidate = useVaultInvalidate();
  const [kind, setKind] = useState<CreateVaultItemRequest["kind"]>("api-credential");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<string>(VAULT_PROVIDERS[0].id);
  const [envName, setEnvName] = useState("");
  const [value, setValue] = useState("");
  const request = (): CreateVaultItemRequest =>
    kind === "api-credential"
      ? { kind, name: name.trim(), provider, value }
      : { kind, name: name.trim(), envName: envName.trim(), value };
  const save = useMutation({
    mutationFn: () => client.vault.create(request()),
    onSuccess: (item) => {
      setName("");
      setEnvName("");
      setValue("");
      invalidate();
      toast.success(`${item.name} saved in the Vault`);
    },
    onError: (e) => toast.error("Not saved", { description: e.message }),
  });
  const short = value.length > 0 && value.length < VAULT_VALUE_MIN;
  const complete =
    name.trim() !== "" &&
    value.length >= VAULT_VALUE_MIN &&
    (kind === "api-credential" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName.trim()));
  return (
    <SettingsSection title="Add a secret">
      <SettingRow label="Kind">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "api-credential", label: "API key" },
            { value: "env-secret", label: "Environment variable" },
          ]}
        />
      </SettingRow>
      <SettingRow label="Name" help="How it is shown here and in the activity log.">
        <Input
          aria-label="Secret name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-60 text-xs"
        />
      </SettingRow>
      {kind === "api-credential" ? (
        <SettingRow label="Provider">
          <select
            aria-label="Provider"
            className={selectClass}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {VAULT_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </SettingRow>
      ) : (
        <SettingRow
          label="Variable"
          help="The environment variable sessions get, e.g. DATABASE_URL."
        >
          <Input
            aria-label="Variable name"
            value={envName}
            onChange={(e) => setEnvName(e.target.value)}
            className="h-8 w-60 font-mono text-xs"
          />
        </SettingRow>
      )}
      <SettingRow
        label="Value"
        help={
          short ? (
            <span role="alert">
              At least {VAULT_VALUE_MIN} characters, so it can be hidden in transcripts.
            </span>
          ) : (
            "Sent to the Vault and never shown again."
          )
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label="Secret value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-60 font-mono text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!complete || save.isPending}
            onClick={() => save.mutate()}
          >
            <KeyRound /> Save
          </Button>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}

function ImportEnv() {
  const client = useClient();
  const invalidate = useVaultInvalidate();
  const [text, setText] = useState("");
  const run = useMutation({
    mutationFn: () => client.vault.importEnv(text),
    onSuccess: () => {
      setText("");
      invalidate();
    },
    onError: (e) => toast.error("Not imported", { description: e.message }),
  });
  const readFile = async (file: File | undefined) => {
    if (file) setText(await file.text());
  };
  return (
    <SettingsSection
      title="Import a .env file"
      description="Each NAME=value line becomes an environment variable secret named after it. Variables the Vault already has are left as they are."
    >
      <div className="space-y-2 px-4 py-3.5">
        <Textarea
          aria-label=".env contents"
          placeholder="DATABASE_URL=postgres://…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-28 font-mono text-xs"
          spellCheck={false}
        />
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <FileUp className="size-4" /> Choose a file
            <input
              type="file"
              className="sr-only"
              aria-label="Choose a .env file"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={!text.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            Import
          </Button>
        </div>
        {run.data && (
          <div className="space-y-1 text-2xs" data-testid="vault-import-result">
            <div>
              Saved {run.data.created.length} {run.data.created.length === 1 ? "secret" : "secrets"}
              . If you don't need the file any more, delete it: it still holds the values.
            </div>
            {run.data.skipped.map((s) => (
              <div key={s.line} className="text-muted-foreground">
                Line {s.line}
                {s.name ? ` (${s.name})` : ""}: {s.reason}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function VaultActivity() {
  const client = useClient();
  const audit = useQuery({
    queryKey: [...vaultKey, "audit"],
    queryFn: () => client.vault.audit({ limit: 50 }),
  });
  if (!audit.data?.length) return null;
  return (
    <SettingsSection
      title="Vault activity"
      description="Every use, grant and change. Never values."
    >
      {audit.data.map((e) => (
        <div key={e.seq} className="flex gap-3 px-4 py-2 text-xs" data-testid="vault-activity">
          <span className="w-36 shrink-0 text-muted-foreground">
            {new Date(e.at).toLocaleString()}
          </span>
          <span className="w-28 shrink-0 font-medium">{ACTIONS[e.action]}</span>
          <span className="min-w-0 truncate">
            {e.itemName}
            {e.detail && <span className="text-muted-foreground"> · {e.detail}</span>}
          </span>
        </div>
      ))}
    </SettingsSection>
  );
}
