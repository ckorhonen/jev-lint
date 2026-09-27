import { loadFont } from "@remotion/fonts";
import type React from "react";
import { Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const FONT = "Departure Mono";

loadFont({ family: FONT, url: staticFile("DepartureMono-Regular.woff2"), display: "block" });

// Monochrome. Red and green only carry meaning: flagged vs fixed / fewer violations.
export const C = {
  bg: "#050505",
  fg: "#f2f2f2",
  dim: "#8a8a8a",
  faint: "#3a3a3a",
  line: "#1e1e1e",
  panel: "#0c0c0c",
  red: "#ff5a4e",
  redBg: "rgba(255,90,78,0.13)",
  green: "#46d27d",
  greenBg: "rgba(70,210,125,0.13)",
};

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const ease = Easing.bezier(0.22, 1, 0.36, 1); // easeOutQuint-ish
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

export const useLayout = () => {
  const { width, height } = useVideoConfig();
  const square = Math.abs(width - height) < 10;
  return { square, width, height, pad: square ? 72 : 140 };
};

// Spring 0→1 starting at `delay` frames.
export const useEnter = (delay = 0, config: Parameters<typeof spring>[0]["config"] = { damping: 200 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config });
};

// Word-by-word kinetic reveal: each word rises and un-blurs with a staggered spring.
export const Words: React.FC<{
  text: string;
  delay?: number;
  stagger?: number;
  style?: React.CSSProperties;
  color?: (word: string, i: number) => string | undefined;
}> = ({ text, delay = 0, stagger = 3, style, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: "0.6em", ...style }}>
      {text.split(" ").map((w, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 18, stiffness: 160 } });
        return (
          <span
            key={`${w}-${i}`}
            style={{
              display: "inline-block",
              opacity: interpolate(p, [0, 0.6], [0, 1], clamp),
              transform: `translateY(${interpolate(p, [0, 1], [0.6, 0])}em)`,
              filter: `blur(${interpolate(p, [0, 1], [8, 0], clamp)}px)`,
              color: color?.(w, i),
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

// Typewriter via string slicing (per skill rules), with an optional block cursor.
export const Typed: React.FC<{
  text: string;
  start: number;
  cps?: number; // characters per second
  cursor?: boolean;
  style?: React.CSSProperties;
}> = ({ text, start, cps = 30, cursor = false, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  const shown = text.slice(0, n);
  const done = n >= text.length;
  const blink = Math.floor(frame / (fps / 2)) % 2 === 0;
  return (
    <span style={style}>
      {shown}
      {cursor && (!done || blink) && frame >= start ? <span style={{ opacity: 0.9 }}>█</span> : null}
    </span>
  );
};

// Slow camera: interpolates scale / translate across keyframes with an in-out ease.
export const Camera: React.FC<{
  keys: { f: number; s: number; x?: number; y?: number }[];
  children: React.ReactNode;
}> = ({ keys, children }) => {
  const frame = useCurrentFrame();
  const fs = keys.map((k) => k.f);
  const opt = { ...clamp, easing: easeInOut };
  const s = interpolate(frame, fs, keys.map((k) => k.s), opt);
  const x = interpolate(frame, fs, keys.map((k) => k.x ?? 0), opt);
  const y = interpolate(frame, fs, keys.map((k) => k.y ?? 0), opt);
  return (
    <div style={{ position: "absolute", inset: 0, transform: `translate(${x}px, ${y}px) scale(${s})`, transformOrigin: "50% 50%" }}>
      {children}
    </div>
  );
};

export const Fill: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ position: "absolute", inset: 0, background: C.bg, color: C.fg, fontFamily: FONT, overflow: "hidden", ...style }}>
    {children}
  </div>
);

// Faint dot grid that drifts slowly, for depth on title cards.
export const DotGrid: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => {
  const frame = useCurrentFrame();
  const off = (frame * 0.4) % 44;
  return (
    <div
      style={{
        position: "absolute",
        inset: -44,
        opacity,
        backgroundImage: `radial-gradient(${C.faint} 1.5px, transparent 1.6px)`,
        backgroundSize: "44px 44px",
        transform: `translate(${off}px, ${off * 0.5}px)`,
      }}
    />
  );
};
