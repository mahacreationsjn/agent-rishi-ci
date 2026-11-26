import {
  type FactoryStatus,
  isFactoryMode,
  type Session,
  type Snapshot,
} from "@agent-rishi/contracts";
import { Link } from "@tanstack/react-router";
import { Bot, Factory, MessageSquare } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/bits";
import type { SceneChat } from "@/components/factory-view/floor/floor-scene";
import { useChatColumn, useNow, useRoomy, useWide } from "@/components/factory-view/hooks";
import { ItemSheet } from "@/components/factory-view/item-sheet";
import { PipelineBoard } from "@/components/factory-view/pipeline-board";
import { ProjectActivity } from "@/components/factory-view/project-activity";
import { QuickChat } from "@/components/factory-view/quick-chat";
import { sceneAgents } from "@/components/factory-view/scene/agents";
import { type StoreyFocus, storeyFocus, storeyTabs } from "@/components/factory-view/scene/storeys";
import { type SessionInfo, type ViewCard, viewPipeline } from "@/components/factory-view/stages";
import { StatsStrip } from "@/components/factory-view/stats-strip";
import { StoreyTabs } from "@/components/factory-view/storey-tabs";
import { ViewHeader } from "@/components/factory-view/view-header";
import { useViewMode } from "@/components/factory-view/view-mode";
import { FloorScene } from "@/components/on-demand";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryStatus } from "@/lib/factory";
import { useProjectStatus } from "@/lib/orchestration";
import { useProject, useSessionLookups, useSnapshot, useSnapshotData } from "@/lib/queries";

const CHAT_KEY = "agent-rishi.factoryView.chat";
const noSessions: Session[] = [];
const noProviders: Snapshot["runner"]["providers"] = [];

/** Every session the view reads: each item's builder, active and reviewer sessions, the scout's. */
function sessionIdsOf(f: FactoryStatus): string[] {
  const ids = new Set<string>();
  for (const w of [...f.backlog, ...f.inProgress, ...f.viewRecent, ...f.recent]) {
    for (const id of [w.activeSessionId, w.sessionId, w.reviewerSessionId]) if (id) ids.add(id);
  }
  const scout = f.mode === "dark_factory" ? f.scout : null;
  if (scout?.sessionId) ids.add(scout.sessionId);
  for (const lens of scout?.lenses ?? []) ids.add(lens.sessionId);
  return [...ids];
}

/** Whether the PM chat column is open on wide screens; remembered across visits. */
function useChatOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(CHAT_KEY) !== "closed");
  return [
    open,
    (next) => {
      localStorage.setItem(CHAT_KEY, next ? "open" : "closed");
      setOpen(next);
    },
  ];
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {children}
    </div>
  );
}

/**
 * The Factory view (§10.1): a full-screen, calm view of one factory for a second screen. The
 * pipeline with every item as a card, a strip of figures, a quick line to the PM, and the
 * kill switch. Outside the app shell: no sidebar or side panels. Everything arrives over the
 * WebSocket, as on the factory panel.
 */
export function FactoryViewPage({ projectId }: { projectId: string }) {
  const { data: snapshot } = useSnapshot();
  const project = useProject(projectId);
  const factory = project ? isFactoryMode(project.autonomyMode) : false;
  const { data: f, isFetching } = useFactoryStatus(projectId, factory);
  const { work, status, isFetching: activityRefreshing } = useProjectStatus(projectId, factory);
  const sessionList = useSnapshotData((s) => s.sessions, noSessions);
  // The items' sessions by id, in one request: finished work's are archived and may be out of
  // the snapshot (§6).
  const itemSessions = useSessionLookups(useMemo(() => (f ? sessionIdsOf(f) : []), [f]));
  const providers = useSnapshotData((s) => s.runner.providers, noProviders);
  const sessions = useMemo(() => {
    const names = new Map(providers.map((p) => [p.id, p.displayName]));
    return new Map<string, SessionInfo>(
      [...sessionList, ...itemSessions.values()].map((s) => [
        s.id,
        {
          status: s.status,
          progress: s.progress?.text ?? null,
          progressAt: s.progress?.at ?? null,
          provider: names.get(s.provider) ?? s.provider,
          providerId: s.provider,
          model: s.model,
          workKey: s.workKey,
        },
      ]),
    );
  }, [sessionList, itemSessions, providers]);
  const now = useNow();
  const pipeline = useMemo(() => (f ? viewPipeline(f, sessions, now) : null), [f, sessions, now]);
  // A dark factory's Floor has two storeys: the Workshop and the Lookout above it. Phones show
  // one at a time.
  const pm = useRoleSession("pm", projectId);
  const pmSessionId = pm?.id ?? null;
  const dark = f?.mode === "dark_factory" && Boolean(f.scout);
  const oneStorey = !useRoomy();
  const [storeyPick, setStoreyPick] = useState<StoreyFocus | null>(null);
  const storeyList = useMemo(
    () =>
      f && pipeline && dark
        ? storeyTabs(sceneAgents({ f, pipeline, sessions, pmSessionId }), dark, oneStorey)
        : [],
    [f, pipeline, sessions, pmSessionId, dark, oneStorey],
  );
  const focus = storeyFocus(storeyPick, dark, oneStorey);
  const wide = useWide();
  // The chat sits beside the pipeline only where six readable columns still fit next to it.
  const chatColumn = useChatColumn();
  const [chatOpen, setChatOpen] = useChatOpen();
  const [chatSheet, setChatSheet] = useState(false);
  const view = useViewMode();
  // Floor mode falls back to the board, for this visit, when WebGL can't start or is lost.
  const [noWebgl, setNoWebgl] = useState(false);
  const floor = view.mode === "floor" && !noWebgl;
  // Floor fills the space; the chat is part of it, docked where the column would be, or opened
  // over the scene on narrower screens.
  const scene = floor;
  const [sceneOverlay, setSceneOverlay] = useState(false);
  const sceneChat: SceneChat = chatColumn
    ? { docked: true, open: chatOpen, setOpen: setChatOpen }
    : { docked: false, open: sceneOverlay, setOpen: setSceneOverlay };
  // The open card by id, so its sheet follows the card as it moves.
  const [selected, setSelected] = useState<ViewCard | null>(null);
  const current = useMemo(() => {
    if (!selected || !pipeline) return selected;
    const all = [...Object.values(pipeline.stages).flat(), ...pipeline.needsYou];
    return all.find((c) => c.item.id === selected.item.id) ?? selected;
  }, [selected, pipeline]);

  if (!snapshot)
    return (
      <Frame>
        <Skeleton className="m-6 h-72 rounded-xl" />
      </Frame>
    );
  if (!project)
    return (
      <Frame>
        <EmptyState icon={<Factory />} title="Project not found" className="flex-1">
          <Link to="/" className="text-primary hover:underline">
            Back to Agent Rishi
          </Link>
        </EmptyState>
      </Frame>
    );
  if (!factory)
    return (
      <Frame>
        <EmptyState
          icon={<Factory />}
          title="Not a factory project"
          className="flex-1"
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to="/projects/$projectId" params={{ projectId }}>
                Back to the project
              </Link>
            </Button>
          }
        >
          {project.name} isn't in software factory or dark factory mode, so there's no factory to
          show.
        </EmptyState>
      </Frame>
    );
  if (!f || !pipeline)
    return (
      <Frame>
        <div className="h-14 border-b border-border" />
        <div className="space-y-3 p-4">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </Frame>
    );

  return (
    <Frame>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="factory-view">
        <ViewHeader
          project={project}
          f={f}
          needsPerson={pipeline.needsPerson}
          failed={pipeline.failed}
          view={view}
          storeys={
            floor ? (
              <StoreyTabs tabs={storeyList} focus={focus} onFocus={setStoreyPick} />
            ) : undefined
          }
        />
        <ProjectActivity
          factory={f}
          work={work}
          sessions={sessionList}
          loaded={Boolean(status)}
          refreshing={isFetching || activityRefreshing}
        />
        <div className="flex min-h-0 flex-1">
          {scene ? (
            // Floor fills the space; its dial and status board stand in for the figures, and
            // the PM chat is part of it.
            <main
              className={
                wide
                  ? "flex min-h-0 min-w-0 flex-1 flex-col p-3"
                  : "flex min-h-0 min-w-0 flex-1 flex-col p-3 pb-16"
              }
            >
              <FloorScene
                f={f}
                pipeline={pipeline}
                sessions={sessions}
                projectId={projectId}
                now={now}
                onOpen={setSelected}
                chat={sceneChat}
                focus={focus}
                onUnsupported={() => setNoWebgl(true)}
              />
            </main>
          ) : (
            <main
              className={
                wide
                  ? // Scrolls only when the window is too short for the figures, the lane and a
                    // usable pipeline together.
                    "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 scroll-thin"
                  : "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pb-20"
              }
            >
              {view.mode === "floor" && noWebgl && (
                <p
                  role="status"
                  className="text-xs text-muted-foreground"
                  data-testid="factory-view-floor-unsupported"
                >
                  Factory floor needs WebGL; showing the board.
                </p>
              )}
              <StatsStrip f={f} />
              <PipelineBoard f={f} pipeline={pipeline} now={now} onOpen={setSelected} />
            </main>
          )}
          {chatColumn && chatOpen && !scene && (
            <aside
              className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface/40 2xl:w-[400px]"
              aria-label="Project manager chat"
            >
              <QuickChat projectId={projectId} onCollapse={() => setChatOpen(false)} />
            </aside>
          )}
          {wide && !(chatColumn && (chatOpen || scene)) && (
            <button
              type="button"
              onClick={() =>
                scene ? setSceneOverlay(true) : chatColumn ? setChatOpen(true) : setChatSheet(true)
              }
              className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border py-3 text-2xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Show the PM chat"
              data-testid="factory-view-chat-show"
            >
              <Bot className="size-4 text-primary" aria-hidden />
              <span className="[writing-mode:vertical-rl]">PM chat</span>
            </button>
          )}
        </div>
        {!wide && (
          <Button
            className="fixed right-4 bottom-4 z-10 rounded-full shadow-lg"
            onClick={() => (scene ? setSceneOverlay(true) : setChatSheet(true))}
            data-testid="factory-view-chat-open"
          >
            <MessageSquare /> PM chat
          </Button>
        )}
        {!chatColumn && !scene && (
          // Narrower screens: the chat slides in from the right (tablets in landscape, small
          // laptops) or up from the bottom (phones, portrait tablets).
          <Sheet open={chatSheet} onOpenChange={setChatSheet}>
            <SheetContent
              side={wide ? "right" : "bottom"}
              showCloseButton={false}
              className="gap-0 p-0 data-[side=bottom]:h-[85dvh] data-[side=bottom]:rounded-t-2xl data-[side=right]:w-[min(26rem,90vw)] data-[side=right]:sm:max-w-none"
            >
              <SheetTitle className="sr-only">Project manager chat</SheetTitle>
              <SheetDescription className="sr-only">
                The latest messages with this project's PM
              </SheetDescription>
              <QuickChat projectId={projectId} onCollapse={() => setChatSheet(false)} />
            </SheetContent>
          </Sheet>
        )}
        <ItemSheet projectId={projectId} card={current} onClose={() => setSelected(null)} />
      </div>
    </Frame>
  );
}
