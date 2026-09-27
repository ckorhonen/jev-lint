import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, Camera, DotGrid, Fill, Typed, Words, clamp, ease, useEnter, useLayout } from "./theme";

/* ───────────── 1. The problem ───────────── */
export const SceneRules: React.FC = () => {
  const { square, pad } = useLayout();
  const h = square ? 66 : 88;
  const rules = ["// don't use useEffect to derive state", "// a test must be able to fail", "// validate JSON before you cast it"];
  return (
    <Fill>
      <Camera keys={[{ f: 0, s: 1 }, { f: 135, s: 1.05 }]}>
        <div style={{ position: "absolute", left: pad, right: pad, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Words text="Your team has rules" delay={4} style={{ fontSize: h, lineHeight: 1.2 }} />
          <Words text="no linter can check." delay={14} style={{ fontSize: h, lineHeight: 1.2, color: C.dim }} />
          <div style={{ marginTop: square ? 56 : 72, fontSize: square ? 28 : 33, lineHeight: 1.8, color: "#c4c4c4" }}>
            {rules.map((r, i) => (
              <div key={r} style={{ height: "1.8em" }}>
                <Typed text={r} start={34 + i * 20} cps={48} cursor={i === rules.length - 1} />
              </div>
            ))}
          </div>
        </div>
      </Camera>
    </Fill>
  );
};

/* ───────────── 2. Caught at review ───────────── */
export const SceneReview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { square, pad } = useLayout();
  const nodes = ["agent writes", "review", "agent fixes", "review again"];
  const fs = square ? 22 : 30;
  const loop = useEnter(62);
  return (
    <Fill>
      <Camera keys={[{ f: 0, s: 1.03 }, { f: 135, s: 1 }]}>
        <div style={{ position: "absolute", left: pad, right: pad, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Words text="So they wait for code review." delay={2} style={{ fontSize: square ? 60 : 88, lineHeight: 1.2 }} />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 24, marginTop: square ? 64 : 80, fontSize: fs }}>
            {nodes.map((n, i) => {
              const p = spring({ frame: frame - 16 - i * 9, fps, config: { damping: 14, stiffness: 170 } });
              const line = interpolate(frame, [22 + i * 9, 30 + i * 9], [0, 1], { ...clamp, easing: ease });
              const hot = i >= 2; // the extra round trip
              return (
                <div key={n} style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      padding: "0.55em 0.9em",
                      border: `2px solid ${hot && loop > 0.5 ? C.red : C.faint}`,
                      color: hot && loop > 0.5 ? C.red : C.fg,
                      opacity: interpolate(p, [0, 0.5], [0, 1], clamp),
                      transform: `scale(${interpolate(p, [0, 1], [0.7, 1])})`,
                    }}
                  >
                    {n}
                  </div>
                  {i < nodes.length - 1 ? (
                    <div style={{ display: "flex", alignItems: "center", width: square ? 30 : 72, padding: "0 10px" }}>
                      <div style={{ height: 2, flex: 1, background: C.dim, transform: `scaleX(${line})`, transformOrigin: "0 50%" }} />
                      <span style={{ color: C.dim, opacity: line, marginLeft: -4 }}>›</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 40, fontSize: square ? 26 : 33, lineHeight: 1.5, color: C.dim, opacity: loop, transform: `translateY(${(1 - loop) * 16}px)` }}>
            <span style={{ color: C.red }}>+1 round trip.</span> The code goes back, and the fix is reviewed again.
          </div>
        </div>
      </Camera>
    </Fill>
  );
};

/* ───────────── 3. Title ───────────── */
export const SceneTitle: React.FC = () => {
  const { square } = useLayout();
  return (
    <Fill>
      <DotGrid opacity={0.8} />
      <Camera keys={[{ f: 0, s: 1.08 }, { f: 90, s: 1 }]}>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: square ? 132 : 176, letterSpacing: "-0.02em" }}>
            <Typed text="jev-lint" start={2} cps={20} cursor />
          </div>
          <Words text="a fuzzy linter for coding agents" delay={20} stagger={3} style={{ fontSize: square ? 36 : 44, color: C.dim, marginTop: 24, justifyContent: "center" }} />
        </div>
      </Camera>
    </Fill>
  );
};

/* ───────────── 4. Editor demo ───────────── */
type Row = { text: string; at?: number; del?: number; kind?: "add" | "del" | "flag" };
const KW = /\b(export|function|const|let|return|true|false|new|if)\b/g;

const Code: React.FC<{ text: string }> = ({ text }) => {
  // Monochrome syntax: keywords bright, strings/identifiers mid, punctuation dim.
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(KW)) {
    if (m.index > last) parts.push(<span key={last} style={{ color: "#b9b9b9" }}>{text.slice(last, m.index)}</span>);
    parts.push(<span key={`k${m.index}`} style={{ color: C.fg }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={last} style={{ color: "#b9b9b9" }}>{text.slice(last)}</span>);
  return <>{parts}</>;
};

export const FLAG_AT = 84; // hook fires
export const FIX_AT = 186; // agent edits
export const RECHECK_AT = 282; // hook fires again
export const CHECK_FRAMES = 9; // ~0.3 s at 30 fps

const ROWS: Row[] = [
  { text: "export function UserCard({ id }: Props) {" },
  { text: "  const [user, setUser] = useState<User>();" },
  { text: "" },
  { text: "  useEffect(() => {", at: 18, kind: "flag" },
  { text: "    fetchUser(id).then(setUser);", at: 30, del: FIX_AT, kind: "flag" },
  { text: "    let stale = false;", at: FIX_AT + 26, kind: "add" },
  { text: "    fetchUser(id).then((u) => {", at: FIX_AT + 36, kind: "add" },
  { text: "      if (!stale) setUser(u);", at: FIX_AT + 48, kind: "add" },
  { text: "    });", at: FIX_AT + 60, kind: "add" },
  { text: "    return () => { stale = true; };", at: FIX_AT + 66, kind: "add" },
  { text: "  }, [id]);", at: 50, kind: "flag" },
  { text: "" },
  { text: "  return <UserView user={user} />;" },
  { text: "}" },
];

// Typing bursts for the audio track: [local start frame, chars]; typed at 42 chars/s.
export const DEMO_TYPING = ROWS.filter((r) => r.at !== undefined && r.text.trim()).map((r) => [r.at as number, r.text.length] as const);

export const SceneEditor: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { square } = useLayout();
  const fs = square ? 22 : 30;
  const LH = Math.round(fs * 1.6);

  const rows = ROWS;

  const win = spring({ frame, fps, config: { damping: 200 } });
  const flagGlow = interpolate(frame, [FLAG_AT + CHECK_FRAMES, FLAG_AT + CHECK_FRAMES + 8, FIX_AT, FIX_AT + 8], [0, 1, 1, 0], clamp);
  const addGlow = interpolate(frame, [FIX_AT + 22, FIX_AT + 30, 360, 375], [0, 1, 1, 0.5], clamp);

  // Layout
  const ed = square ? { left: 60, top: 118, width: 960 } : { left: 150, top: 160, width: 1010 };
  const panel = square ? { left: 60, top: interpolate(frame, [FIX_AT + 20, FIX_AT + 70], [555, 690], { ...clamp, easing: ease }), width: 960 } : { left: 1010, top: 520, width: 790 };

  // Panel state
  const panelIn = spring({ frame: frame - FLAG_AT, fps, config: { damping: 16, stiffness: 150 } });
  const second = frame >= RECHECK_AT;
  const checkStart = second ? RECHECK_AT : FLAG_AT;
  const checking = frame < checkStart + CHECK_FRAMES;
  const resultIn = spring({ frame: frame - checkStart - CHECK_FRAMES, fps, config: { damping: 200 } });

  const step = frame < FLAG_AT ? 0 : frame < FIX_AT ? 1 : 2;
  const steps = [
    { n: "01", t: "agent writes code", c: C.fg },
    { n: "02", t: "hook flags it in ~0.3 s", c: C.red },
    { n: "03", t: "agent fixes it before review", c: C.green },
  ];

  const cam = square
    ? [
        { f: 0, s: 1.04, y: 20 },
        { f: 70, s: 1 },
        { f: FLAG_AT - 12, s: 1 },
        { f: FLAG_AT + 16, s: 1.05 },
        { f: FIX_AT - 6, s: 1.05 },
        { f: FIX_AT + 30, s: 1 },
        { f: RECHECK_AT, s: 1 },
        { f: 375, s: 1.04 },
      ]
    : [
        { f: 0, s: 1.04, x: 317 },
        { f: 70, s: 1, x: 305 },
        { f: FLAG_AT - 12, s: 1, x: 305 },
        { f: FLAG_AT + 16, s: 1.1, x: -60, y: -10 },
        { f: FIX_AT - 6, s: 1.1, x: -60, y: -10 },
        { f: FIX_AT + 30, s: 1.02, x: 0, y: 0 },
        { f: RECHECK_AT, s: 1.02 },
        { f: 375, s: 1.06, x: -40, y: 0 },
      ];

  let lineNo = 0;
  return (
    <Fill>
      <Camera keys={cam}>
        {/* Editor window */}
        <div
          style={{
            position: "absolute",
            ...ed,
            background: C.panel,
            border: `2px solid ${C.line}`,
            opacity: win,
            transform: `translateY(${(1 - win) * 40}px)`,
            boxShadow: "0 40px 120px rgba(0,0,0,0.8)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 52, padding: "0 20px", borderBottom: `2px solid ${C.line}`, fontSize: 20, color: C.dim }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ width: 12, height: 12, borderRadius: 6, background: C.faint }} />
            ))}
            <span style={{ marginLeft: 16, color: C.fg }}>src/UserCard.tsx</span>
            <span style={{ marginLeft: "auto" }}>{frame < FIX_AT ? "Claude Code · Edit" : "Claude Code · Edit (fix)"}</span>
          </div>
          <div style={{ padding: "18px 0 22px", fontSize: fs }}>
            {rows.map((r, i) => {
              const grow = r.at === undefined ? 1 : interpolate(frame, [r.at - 6, r.at], [0, 1], { ...clamp, easing: ease });
              const shrink = r.del === undefined ? 1 : interpolate(frame, [r.del + 12, r.del + 22], [1, 0], { ...clamp, easing: ease });
              const hgt = LH * grow * shrink;
              if (hgt < 0.5) return null;
              lineNo += 1;
              const n = r.at === undefined ? r.text.length : Math.max(0, Math.floor(((frame - r.at) / fps) * 42));
              const typing = r.at !== undefined && n < r.text.length && frame >= r.at;
              const isFlag = r.kind === "flag";
              const dying = r.del !== undefined && frame >= r.del;
              const bg = dying
                ? C.redBg
                : isFlag && flagGlow > 0
                  ? `rgba(255,90,78,${0.13 * flagGlow})`
                  : r.kind === "add"
                    ? `rgba(70,210,125,${0.13 * addGlow})`
                    : "transparent";
              const bar = dying ? C.red : isFlag && flagGlow > 0.01 ? C.red : r.kind === "add" && addGlow > 0.01 ? C.green : "transparent";
              return (
                <div key={i} style={{ height: hgt, lineHeight: `${LH}px`, overflow: "hidden", display: "flex", background: bg, borderLeft: `4px solid ${bar}`, opacity: shrink }}>
                  <span style={{ width: fs * 2.6, textAlign: "right", paddingRight: fs, color: C.faint, flexShrink: 0 }}>{lineNo}</span>
                  <span style={{ width: fs * 0.9, color: r.kind === "add" && addGlow > 0.01 ? C.green : dying ? C.red : "transparent" }}>
                    {r.kind === "add" ? "+" : dying ? "-" : " "}
                  </span>
                  <span style={{ whiteSpace: "pre", textDecoration: dying ? "line-through" : undefined }}>
                    <Code text={r.text.slice(0, n)} />
                    {typing ? <span style={{ color: C.fg }}>█</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Hook panel */}
        <div
          style={{
            position: "absolute",
            ...panel,
            background: "#0a0a0a",
            border: `2px solid ${second ? (checking ? C.faint : C.green) : checking ? C.faint : C.red}`,
            padding: "22px 28px",
            fontSize: square ? 21 : 22,
            lineHeight: 1.55,
            opacity: interpolate(panelIn, [0, 0.4], [0, 1], clamp),
            transform: `translateY(${(1 - panelIn) * 60}px) scale(${interpolate(panelIn, [0, 1], [0.94, 1])})`,
            boxShadow: "0 30px 90px rgba(0,0,0,0.9)",
          }}
        >
          <div style={{ display: "flex", color: C.dim }}>
            <span style={{ color: C.fg }}>jev-lint</span>
            <span style={{ marginLeft: 16 }}>PostToolUse hook</span>
            <span style={{ marginLeft: "auto" }}>{checking ? `checking${".".repeat(1 + (Math.floor(frame / 3) % 3))}` : "~0.3 s"}</span>
          </div>
          {!checking && !second ? (
            <div style={{ opacity: resultIn, transform: `translateY(${(1 - resultIn) * 10}px)` }}>
              <div style={{ color: C.dim }}>src/UserCard.tsx (checked only the code this edit added)</div>
              <div style={{ color: C.red, marginTop: 10 }}>Likely violations — fix these:</div>
              <div style={{ color: C.fg }}>  - react-effect-fetch-race (p=0.93)</div>
              <div style={{ color: "#b9b9b9", paddingLeft: "2.2em" }}>
                Use an AbortController (or an `ignore` flag set in the cleanup) and skip setState for stale responses.
              </div>
            </div>
          ) : null}
          {!checking && second ? (
            <div style={{ opacity: resultIn, transform: `translateY(${(1 - resultIn) * 10}px)` }}>
              <div style={{ color: C.dim }}>src/UserCard.tsx</div>
              <div style={{ color: C.green, marginTop: 10, fontSize: square ? 30 : 33 }}>no findings</div>
            </div>
          ) : null}
        </div>
      </Camera>

      {/* Stepper (outside camera so it stays put) */}
      <div
        style={{
          position: "absolute",
          left: square ? 60 : 150,
          right: square ? 60 : 150,
          bottom: square ? 70 : 78,
          display: "flex",
          gap: 40,
          whiteSpace: "nowrap",
          fontSize: square ? 26 : 26,
        }}
      >
        {steps.map((s, i) => {
          if (square && i !== step) return null;
          const on = i === step;
          const p = spring({ frame: frame - [0, FLAG_AT + CHECK_FRAMES, FIX_AT][i], fps, config: { damping: 200 } });
          return (
            <div key={s.n} style={{ color: on ? s.c : C.faint, opacity: on ? interpolate(p, [0, 1], [0.3, 1]) : 1, transform: on ? `translateY(${(1 - p) * 12}px)` : undefined }}>
              <span style={{ color: on ? C.dim : C.faint, marginRight: 14 }}>{s.n}</span>
              {s.t}
            </div>
          );
        })}
        {square ? null : <div style={{ marginLeft: "auto", color: C.faint, fontSize: 20, alignSelf: "center" }}>example session</div>}
      </div>
    </Fill>
  );
};

/* ───────────── 5. Chart ───────────── */
export const SceneChart: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { square, pad, width } = useLayout();
  const groups = [
    { name: "Claude Code", runs: "96 runs", off: 2.38, on: 1.21 },
    { name: "Codex", runs: "48 runs", off: 1.67, on: 0.92 },
  ];
  const MAX = 2.5;
  const labelW = square ? 0 : 330;
  const barMax = width - pad * 2 - labelW - 140;
  const barH = square ? 50 : 56;
  const foot = useEnter(120);
  return (
    <Fill>
      <Camera keys={[{ f: 0, s: 1.03, y: 10 }, { f: 215, s: 1 }]}>
        <div style={{ position: "absolute", left: pad, right: pad, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Words text="Rule violations per task" delay={0} style={{ fontSize: square ? 55 : 66 }} />
          <div style={{ display: "flex", gap: 40, fontSize: square ? 22 : 24, color: C.dim, marginTop: 18, opacity: useEnter(8) }}>
            <span>real agent runs</span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 18, height: 18, background: "#5c5c5c" }} /> hook off
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 18, height: 18, background: C.green }} /> hook on
            </span>
          </div>
          <div style={{ marginTop: square ? 50 : 64, display: "flex", flexDirection: "column", gap: square ? 44 : 52 }}>
            {groups.map((g, gi) => (
              <div key={g.name} style={{ display: "flex", flexDirection: square ? "column" : "row", gap: square ? 14 : 0 }}>
                <div style={{ width: labelW || undefined, fontSize: square ? 28 : 33, paddingTop: 6, opacity: useEnter(20 + gi * 26) }}>
                  {g.name}
                  <div style={{ fontSize: 22, color: C.dim, marginTop: 6 }}>{g.runs}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderLeft: `2px solid ${C.faint}` }}>
                  {(["off", "on"] as const).map((k, ki) => {
                    const d = 26 + gi * 26 + ki * 10;
                    const p = spring({ frame: frame - d, fps, config: { damping: 200 }, durationInFrames: 36 });
                    const v = g[k];
                    return (
                      <div key={k} style={{ display: "flex", alignItems: "center", height: barH }}>
                        <div style={{ height: barH, width: (v / MAX) * barMax * p, background: k === "on" ? C.green : "#5c5c5c" }} />
                        <span style={{ marginLeft: 20, fontSize: square ? 30 : 36, color: k === "on" ? C.green : C.fg, opacity: interpolate(p, [0, 0.3], [0, 1], clamp) }}>
                          {(v * p).toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: square ? 44 : 56, fontSize: square ? 21 : 24, lineHeight: 1.6, color: C.dim, opacity: foot, transform: `translateY(${(1 - foot) * 12}px)` }}>
            Both drops statistically significant. Measured 26–27 Sep 2026.
          </div>
        </div>
      </Camera>
    </Fill>
  );
};

/* ───────────── 6. Where the fix happens ───────────── */
// Numbers: notebook Entries 5–6 (measured 26–27 Sep 2026). Hook: +$0.03–0.04 and +10 s per task.
// One review → fix round: about $0.17–0.19 and 70 s. Check itself: ~$1.51 per 10,000 edits.
export const COST_CARD_AT = [34, 70] as const; // local frames the two cards land (used by the audio track)

const CountUp: React.FC<{ to: number; start: number; fmt: (v: number) => string; style?: React.CSSProperties }> = ({ to, start, fmt, style }) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [start, start + 24], [0, to], { ...clamp, easing: ease });
  return <span style={style}>{fmt(v)}</span>;
};

const CostCard: React.FC<{
  at: number;
  color: string;
  label: string;
  flow: string[];
  loop?: boolean;
  dollars: { to: number; fmt: (v: number) => string };
  secs: { to: number; fmt: (v: number) => string };
  note: string;
}> = ({ at, color, label, flow, loop, dollars, secs, note }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { square } = useLayout();
  const p = spring({ frame: frame - at, fps, config: { damping: 18, stiffness: 150 } });
  const big = square ? 55 : 66;
  const loopP = interpolate(frame, [at + 20, at + 40], [0, 1], { ...clamp, easing: ease });
  return (
    <div
      style={{
        flex: 1,
        border: `2px solid ${color}`,
        padding: square ? "22px 28px" : "30px 36px",
        opacity: interpolate(p, [0, 0.4], [0, 1], clamp),
        transform: `translateY(${(1 - p) * 40}px) scale(${interpolate(p, [0, 1], [0.96, 1])})`,
        background: "#080808",
      }}
    >
      <div style={{ color, fontSize: square ? 26 : 30 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, fontSize: square ? 20 : 22, color: C.dim }}>
        {flow.map((f, i) => (
          <span key={f} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {i > 0 ? <span>→</span> : null}
            <span style={{ padding: "2px 10px", border: `1px solid ${C.faint}` }}>{f}</span>
          </span>
        ))}
        {loop ? (
          <span style={{ color, opacity: loopP, marginLeft: 6 }}>
            ← back to fix
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: square ? 40 : 56, marginTop: square ? 18 : 26, alignItems: "baseline" }}>
        <CountUp to={dollars.to} start={at + 6} fmt={dollars.fmt} style={{ fontSize: big, color: C.fg }} />
        <CountUp to={secs.to} start={at + 10} fmt={secs.fmt} style={{ fontSize: big, color: C.fg }} />
      </div>
      <div style={{ marginTop: 10, fontSize: square ? 20 : 22, color: C.dim, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
};

export const SceneCost: React.FC = () => {
  const { square, pad } = useLayout();
  const top = useEnter(12);
  const foot = useEnter(112);
  return (
    <Fill>
      <Camera keys={[{ f: 0, s: 1 }, { f: 195, s: 1.03 }]}>
        <div style={{ position: "absolute", left: pad, right: pad, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Words text="Fix it at the edit, not at review." style={{ fontSize: square ? 50 : 66 }} />
          <div style={{ marginTop: 16, fontSize: square ? 22 : 26, color: C.dim, opacity: top }}>
            The check itself: ~0.3 s and ~$1.51 per 10,000 edits.
          </div>
          <div style={{ display: "flex", flexDirection: square ? "column" : "row", gap: square ? 24 : 40, marginTop: square ? 36 : 52 }}>
            <CostCard
              at={COST_CARD_AT[0]}
              color={C.green}
              label="caught while editing"
              flow={["edit", "hook", "fix"]}
              dollars={{ to: 0.04, fmt: (v) => `~$${v.toFixed(2)}` }}
              secs={{ to: 10, fmt: (v) => `~${Math.round(v)} s` }}
              note="extra per task: the agent fixes it with the file still open"
            />
            <CostCard
              at={COST_CARD_AT[1]}
              color={C.red}
              label="caught in review"
              flow={["review", "fix", "re-review"]}
              loop
              dollars={{ to: 0.18, fmt: (v) => `≈$${v.toFixed(2)}` }}
              secs={{ to: 70, fmt: (v) => `~${Math.round(v)} s` }}
              note="per review → fix round"
            />
          </div>
          <div style={{ marginTop: square ? 28 : 40, fontSize: square ? 19 : 22, color: C.dim, opacity: foot }}>
            Measured across our agent runs, 26–27 Sep 2026. Details and caveats in the notebook.
          </div>
        </div>
      </Camera>
    </Fill>
  );
};

/* ───────────── 7. End card (also the opening frame / poster) ───────────── */
export const SceneEnd: React.FC<{ still?: boolean }> = ({ still = false }) => {
  const { square } = useLayout();
  const ea = useEnter(0, { damping: 16, stiffness: 140 });
  const eb = useEnter(16);
  const ec = useEnter(30);
  // `still`: fully composed from frame 0, so X's first-frame thumbnail is the finished card.
  const [a, b, c] = still ? [1, 1, 1] : [ea, eb, ec];
  return (
    <Fill>
      <DotGrid opacity={0.8} />
      <Camera keys={still ? [{ f: 0, s: 1 }, { f: 57, s: 1.015 }] : [{ f: 0, s: 1.04 }, { f: 120, s: 1 }]}>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div style={{ fontSize: square ? 110 : 132, opacity: a, transform: `scale(${interpolate(a, [0, 1], [0.9, 1])})` }}>jev-lint</div>
          <div style={{ fontSize: square ? 33 : 40, color: C.dim, marginTop: 16, opacity: a }}>a fuzzy linter for coding agents</div>
          <div
            style={{
              marginTop: 56,
              fontSize: square ? 33 : 44,
              padding: "18px 32px",
              border: `2px solid ${C.fg}`,
              background: C.bg,
              opacity: b,
              transform: `translateY(${(1 - b) * 20}px)`,
            }}
          >
            github.com/ckorhonen/jev-lint
          </div>
          <div style={{ marginTop: 40, fontSize: square ? 20 : 24, color: C.dim, opacity: c }}>
            Claude Code + Codex hook · powered by TypeSafe Jev · MIT
          </div>
        </div>
      </Camera>
    </Fill>
  );
};

export const SceneIntro: React.FC = () => <SceneEnd still />;
