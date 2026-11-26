import type { FactoryStatus } from "@agent-rishi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2 } from "lucide-react";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/lib/motion";
import { useRoomy } from "../hooks";
import { agentCard } from "../scene/agent-card";
import type { SceneAgent } from "../scene/agents";
import { lookoutLayout } from "../scene/lookout";
import { bayCount } from "../scene/repair-bay";
import { sceneSummary } from "../scene/scene-model";
import type { StoreyFocus } from "../scene/storeys";
import { useHover } from "../scene/use-hover";
import type { SessionInfo, ViewCard, ViewPipeline } from "../stages";
import { RecentActivity } from "./activity-icons";
import { AgentCardView, BayCardView } from "./cards";
import { FigureLayer, type OverlayHandle } from "./overlay";
import { useFloorPalette } from "./palette";
import { PmChat } from "./pm-chat";
import { ROSTER_SPACE, Roster } from "./roster";
import { postOf } from "./seat-frames";
import { FloorStage } from "./stage";
import { useAgentActivity } from "./use-activity";
import { useWorkshop } from "./use-workshop";

const TERMINAL_W = 340;

/**
 * The dev-only stats overlay (#476): frames drawn per second, draw calls and triangles of the
 * last frame. Only in development builds, with `?stats` in the URL; production never runs it.
 */
function useStageStats(stage: RefObject<FloorStage | null>): string | null {
  const on = import.meta.env.DEV && new URLSearchParams(window.location.search).has("stats");
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let drawn = stage.current?.stats().drawn ?? 0;
    let at = performance.now();
    const timer = window.setInterval(() => {
      const s = stage.current?.stats();
      if (!s) return;
      const now = performance.now();
      const fps = ((s.drawn - drawn) * 1000) / (now - at);
      drawn = s.drawn;
      at = now;
      setText(
        `${fps.toFixed(0)} fps · ${s.ms.toFixed(1)} ms/frame · ${s.calls} calls · ${(s.triangles / 1000).toFixed(0)}k tris`,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [on, stage]);
  return on ? text : null;
}
/** Session states whose agent can be doing something worth a bubble. */
const LIVE = new Set(["starting", "running", "waiting"]);

/** Where the PM chat goes: docked beside the scene (wide screens) or over it. */
export interface SceneChat {
  docked: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Floor mode (#420, #476): the factory as a 3D Workshop, every agent a small crew figure at the
 * station for its step, its status on the figure (tip light, mouth, pose), a name tag and a
 * thought bubble of its latest activity. Hovering or focusing a figure shows its card; clicking
 * it does what its roster row does and flies the camera to it. Plain Three.js behind a pure
 * model, in its own chunk. The canvas is decorative: the figures' buttons and the roster carry
 * the facts, and a live caption says what the scene shows. Drag to pan, wheel or pinch to zoom,
 * Fit (or a double-click) to frame it all again. Without WebGL it tells the view to show the
 * board instead.
 */
export function FloorScene({
  f,
  pipeline,
  sessions,
  projectId,
  now,
  onOpen,
  chat,
  focus,
  onUnsupported,
}: {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  sessions: ReadonlyMap<string, SessionInfo>;
  projectId: string;
  now: number;
  onOpen: (card: ViewCard) => void;
  chat: SceneChat;
  /** The storey in focus, or both (a dark factory's Lookout over its Workshop). */
  focus: StoreyFocus;
  /** WebGL couldn't start, or its context was lost and not restored. */
  onUnsupported: () => void;
}) {
  const pm = useRoleSession("pm", projectId);
  const { scene, layout } = useWorkshop({ f, pipeline, sessions, pmSessionId: pm?.id ?? null });
  const palette = useFloorPalette();
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<FloorStage | null>(null);
  const overlay = useRef<OverlayHandle>(null);
  const terminal = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const hover = useHover();
  const ids = useId().replace(/:/g, "");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Phones: the roster is a bottom sheet behind a button.
  const phone = !useRoomy();
  // The roster starts open where there's room beside the floor.
  const [rosterOpen, setRosterOpen] = useState(() => window.innerWidth >= 1600);
  const stats = useStageStats(stage);
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const tapRef = useRef<(key: string | null) => void>(() => {});

  // A dark factory's Lookout storey, over the Workshop.
  const lookout = useMemo(
    () => (scene.scout ? lookoutLayout(layout) : null),
    [scene.scout, layout],
  );
  // The agents drawn, in the roster's order: the Workshop's, then the Lookout's.
  const onFloor = useMemo(
    () => scene.agents.filter((a) => postOf(a, scene, layout, lookout) !== null),
    [scene, layout, lookout],
  );
  const lifted = useMemo(
    () =>
      new Set(
        onFloor
          .filter((a) => (scene.seating.seats.get(a.key)?.tile.r ?? 0) % 2 === 1)
          .map((a) => a.key),
      ),
    [onFloor, scene],
  );
  const live = useMemo(
    () =>
      new Set(
        onFloor.flatMap((a) =>
          a.sessionId && LIVE.has(sessions.get(a.sessionId)?.status ?? "") ? [a.sessionId] : [],
        ),
      ),
    [onFloor, sessions],
  );
  const activity = useAgentActivity(useMemo(() => [...live], [live]));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    try {
      stage.current = new FloorStage(el, {
        onLost: () => unsupported.current(),
        onHover: (key) => (key ? hoverRef.current.enter(key) : hoverRef.current.leave()),
        onTap: (key) => tapRef.current(key),
        onFrame: (figures, u, width) => overlay.current?.sync(figures, u, width),
      });
      stage.current.coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    } catch {
      unsupported.current();
      return;
    }
    return () => {
      stage.current?.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    if (stage.current) stage.current.reduced = reduced;
  }, [reduced]);

  useEffect(() => {
    stage.current?.setInset(rosterOpen && !phone ? ROSTER_SPACE : 0);
  }, [rosterOpen, phone]);

  useEffect(() => {
    stage.current?.update({ layout, scene, palette, lookout });
  }, [layout, scene, palette, lookout]);

  useEffect(() => {
    stage.current?.setFocus(focus);
  }, [focus]);

  const focusChat = () => {
    chat.setOpen(true);
    // After the chat renders: its message box.
    window.setTimeout(() => terminal.current?.querySelector("textarea")?.focus(), 60);
  };
  const openItem = (a: SceneAgent): (() => void) | null => {
    const card = a.card;
    if (card) return () => onOpen(card);
    return a.role === "pm" ? focusChat : null;
  };
  /** What clicking an agent does, in the scene or the roster: select it, then open it. */
  const activate = (a: SceneAgent) => {
    stage.current?.select(a.key);
    setFocusKey(a.key);
    const open = openItem(a);
    if (open) return open();
    if (a.sessionId)
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: a.sessionId } });
  };
  const crateOf = (key: string | null) =>
    key?.startsWith("bay:") ? scene.bay.find((c) => `bay:${c.kind}` === key) : undefined;
  /** A figure's key does what its roster row does; a crate's opens its card. */
  const activateKey = (key: string | null) => {
    const a = key ? scene.agents.find((x) => x.key === key) : undefined;
    if (a) return activate(a);
    if (crateOf(key) && key) return hover.enter(key);
    stage.current?.select(null);
  };
  tapRef.current = activateKey;
  const terminalProps = { projectId, onFold: () => chat.setOpen(false), ref: terminal };
  const hovered = onFloor.find((a) => a.key === hover.key) ?? null;
  const crate = crateOf(hover.key);
  const cardId = `${ids}-figure-card`;
  const keep = () => hover.key && hover.enter(hover.key);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="factory-view-floor-scene">
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={host}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/20"
        >
          {/* The stage puts its canvas (aria-hidden) here. */}
          <FigureLayer
            ref={overlay}
            agents={onFloor}
            lifted={lifted}
            live={live}
            store={activity}
            now={now}
            hovered={hovered?.key ?? (crate ? hover.key : null)}
            focusKey={focusKey ?? onFloor[0]?.key ?? null}
            cardId={cardId}
            crates={scene.bay.slice(0, 3)}
            card={
              hovered ? (
                <AgentCardView
                  id={cardId}
                  agent={hovered}
                  card={agentCard(hovered, now)}
                  recent={<RecentActivity store={activity} sessionId={hovered.sessionId} />}
                  onEnter={keep}
                  onLeave={hover.leave}
                  onOpenItem={openItem(hovered)}
                />
              ) : crate ? (
                <BayCardView
                  id={cardId}
                  crate={crate}
                  projectId={projectId}
                  onEnter={keep}
                  onLeave={hover.leave}
                  onOpen={onOpen}
                />
              ) : null
            }
            onFocusFigure={(key) => {
              setFocusKey(key);
              hover.enter(key);
              stage.current?.reveal(key);
            }}
            onBlurFigure={hover.leave}
            onActivate={activateKey}
          />
          <Roster
            agents={scene.agents}
            byStorey={lookout !== null}
            sheet={phone}
            now={now}
            open={rosterOpen}
            setOpen={setRosterOpen}
            onActivate={activate}
            onOpenItem={openItem}
          />
          {stats && (
            <p
              className="pointer-events-none absolute top-2 right-2 z-10 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-white"
              data-testid="factory-view-floor-stats"
            >
              {stats}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="absolute right-2 bottom-2 z-10 bg-background/90"
            onClick={() => stage.current?.fit(true)}
            title="Frame the whole factory floor (or double-click the floor)"
            data-testid="factory-view-floor-fit"
          >
            <Maximize2 /> Fit
          </Button>
          {!chat.docked && chat.open && (
            <PmChat
              {...terminalProps}
              className="absolute inset-y-2 right-2 z-30 w-[min(360px,85%)]"
            />
          )}
        </div>
        {chat.docked &&
          (chat.open ? (
            <PmChat {...terminalProps} className="shrink-0" style={{ width: TERMINAL_W }} />
          ) : (
            <button
              type="button"
              onClick={focusChat}
              className="flex w-8 shrink-0 flex-col items-center gap-2 rounded-lg border border-border bg-surface/40 py-2 text-2xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Show the PM chat"
              data-testid="factory-view-chat-show"
            >
              <span className="[writing-mode:vertical-rl]">PM chat</span>
            </button>
          ))}
      </div>
      <p
        aria-live="polite"
        className="shrink-0 text-center text-2xs text-muted-foreground"
        data-testid="factory-view-floor-summary"
        data-bay={bayCount(scene.bay)}
      >
        {sceneSummary(scene)}
      </p>
    </div>
  );
}
