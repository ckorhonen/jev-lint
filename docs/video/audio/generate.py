#!/usr/bin/env python3
"""Procedurally synthesise the music bed and SFX for the jev-lint launch video.

Everything here is generated from sine/saw oscillators and filtered noise with a fixed seed, so the
audio is ours (no samples, no downloaded tracks) and re-running produces identical files.
Scene timings come from ../src/timeline.json, the same file the Remotion composition uses.

Outputs (48 kHz, 16-bit WAV) in ../public/audio/:
  music.wav   full-length bed: pad + soft pulse, build into the chart, resolve on the end card
  typing.wav  12 s loop of soft keyboard ticks (trimmed per typing burst in Remotion)
  thunk.wav   low soft alert for the red finding
  chime.wav   soft two-note chime for the green "no findings"
  whoosh.wav  gentle filtered-noise transition
  pop.wav     small pop for nodes / bars / cards landing
"""

import json
import os

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "audio")
rng = np.random.default_rng(7)

tl = json.load(open(os.path.join(HERE, "..", "src", "timeline.json")))
FPS, T = tl["fps"], tl["transition"]
starts, acc = {}, 0
for i, s in enumerate(tl["scenes"]):
    starts[s["id"]] = (acc - i * T) / FPS
    acc += s["d"]
TOTAL = (acc - (len(tl["scenes"]) - 1) * T) / FPS

BPM = 100
BEAT = 60 / BPM


def t_arr(dur):
    return np.arange(int(dur * SR)) / SR


def lp(x, hz, order=2):
    return sosfilt(butter(order, hz, "low", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def saw(f, t, phase=0.0):
    return 2 * ((f * t + phase) % 1.0) - 1


def write(name, x):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    peak = np.max(np.abs(x)) or 1.0
    x = x / peak * 10 ** (-6 / 20)  # normalise every asset to -6 dBFS peak; mix levels live in Remotion
    wavfile.write(os.path.join(OUT, name), SR, (x * 32767).astype(np.int16))


def reverb(x, secs=1.8, wet=0.22):
    n = int(secs * SR)
    ir = rng.standard_normal((n, 2)) * np.exp(-np.arange(n) / (secs * SR / 6.0))[:, None]
    ir = np.stack([lp(ir[:, 0], 5000), lp(ir[:, 1], 5000)], axis=1)
    ir /= np.sqrt(np.sum(ir**2, axis=0))
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return (1 - wet) * x + wet * y


# ───────────────────────── music ─────────────────────────
def music():
    n = int(TOTAL * SR)
    out = np.zeros((n, 2))
    t_story, t_chart, t_cost, t_end = starts["problem"], starts["results"], starts["cost"], starts["end"]

    # Chords (MIDI) — F major colour, two bars each: Fmaj7, Am7, Dm9, Cadd9; resolve on Fmaj9.
    prog = [[53, 57, 60, 64], [57, 60, 64, 67], [50, 57, 60, 64, 65], [48, 55, 62, 64]]
    resolve = [53, 57, 60, 64, 67]
    bar2 = 8 * BEAT

    def pad_chord(notes, t0, dur, gain):
        a, r = 0.9, 1.2
        m = int((dur + r) * SR)
        i0 = int(t0 * SR)
        if i0 >= n:
            return
        m = min(m, n - i0)
        t = np.arange(m) / SR
        env = np.clip(t / a, 0, 1) * np.clip((dur + r - t) / r, 0, 1)
        sig = np.zeros((m, 2))
        for k, note in enumerate(notes):
            f = hz(note)
            for c, cents in enumerate((-4, 4)):
                ff = f * 2 ** (cents / 1200)
                v = 0.6 * saw(ff, t, 0.13 * k + 0.31 * c) + 0.4 * np.sin(2 * np.pi * ff * t)
                sig[:, c] += v
        bass = np.sin(2 * np.pi * hz(notes[0] - 12) * t)
        sig += 0.3 * bass[:, None]
        sig = np.stack([lp(sig[:, c], 900) for c in range(2)], axis=1)
        out[i0 : i0 + m] += sig * env[:, None] * gain

    # Pad: intro fades in from 0; progression through the story; resolve chord on the end card.
    t = 0.0
    k = 0
    while t < t_end:
        dur = min(bar2, t_end - t)
        pad_chord(prog[k % 4], t, dur, 0.05)
        t += bar2
        k += 1
    pad_chord(resolve, t_end, TOTAL - t_end, 0.06)

    # Pulse: soft plucked eighths from the story start until the end card, brighter in the build + chart.
    step = BEAT / 2
    tt = t_story
    j = 0
    while tt < t_end - 0.05:
        chord = prog[int(tt // bar2) % 4]
        pattern = [chord[0] + 12, chord[2] + 12, chord[1] + 12, chord[2] + 12]
        f = hz(pattern[j % 4])
        build = np.clip((tt - (t_chart - 2.0)) / 2.0, 0, 1)
        bright = 0.15 + 0.35 * build
        level = 0.035 + 0.02 * build - 0.012 * np.clip((tt - t_cost) / 2, 0, 1)
        m = int(0.35 * SR)
        s = np.arange(m) / SR
        env = np.exp(-s / 0.11) * np.clip(s / 0.004, 0, 1)
        v = np.sin(2 * np.pi * f * s) + bright * np.sin(2 * np.pi * 2 * f * s) + 0.5 * bright * np.sin(2 * np.pi * 3 * f * s)
        i0 = int(tt * SR)
        pan = 0.5 + 0.25 * (1 if j % 2 else -1)
        seg = v * env * level
        e = min(i0 + m, n)
        out[i0:e, 0] += seg[: e - i0] * (1 - pan) * 2
        out[i0:e, 1] += seg[: e - i0] * pan * 2
        tt += step
        j += 1

    # Soft kick on quarters through chart + cost (lighter in cost).
    tt = t_chart
    while tt < t_end - 0.1:
        m = int(0.3 * SR)
        s = np.arange(m) / SR
        f = 45 + 70 * np.exp(-s / 0.03)
        ph = 2 * np.pi * np.cumsum(f) / SR
        lvl = 0.1 if tt < t_cost else 0.06
        k_sig = np.sin(ph) * np.exp(-s / 0.09) * lvl
        i0 = int(tt * SR)
        e = min(i0 + m, n)
        out[i0:e] += k_sig[: e - i0, None]
        tt += BEAT

    # Riser: 2 s filtered-noise swell into the chart reveal, then a soft low swell on the downbeat.
    rs = 2.0
    m = int(rs * SR)
    s = np.arange(m) / SR
    noise = rng.standard_normal(m)
    chunks = []
    for c in range(16):
        a, b = c * m // 16, (c + 1) * m // 16
        centre = 400 + 3000 * (c / 15) ** 2
        chunks.append(bp(noise, centre * 0.7, centre * 1.3)[a:b])
    riser = np.concatenate(chunks) * (s / rs) ** 2 * 0.05
    i0 = int((t_chart - rs) * SR)
    out[i0 : i0 + m] += riser[:, None]
    m = int(1.5 * SR)
    s = np.arange(m) / SR
    boom = np.sin(2 * np.pi * 55 * s) * np.exp(-s / 0.5) * 0.07
    i0 = int(t_chart * SR)
    out[i0 : i0 + m] += boom[:, None]

    out = reverb(out, 2.2, 0.28)
    # Global fades: in over the intro, out over the last 2 s.
    tt = np.arange(n) / SR
    fade = np.clip(tt / 1.0, 0, 1) * np.clip((TOTAL - tt) / 2.0, 0, 1)
    out *= fade[:, None]
    write("music.wav", out)


# ───────────────────────── SFX ─────────────────────────
def click(level=1.0, pitch=1.0):
    m = int(0.03 * SR)
    s = np.arange(m) / SR
    n = bp(rng.standard_normal(m), 1800 * pitch, 6000 * pitch) * np.exp(-s / 0.004)
    body = np.sin(2 * np.pi * 180 * pitch * s) * np.exp(-s / 0.012) * 0.5
    return (n + body) * level


def typing():
    dur = 12.0
    x = np.zeros(int(dur * SR))
    tt = 0.0
    while tt < dur - 0.05:
        c = click(rng.uniform(0.5, 1.0), rng.uniform(0.85, 1.15))
        i0 = int(tt * SR)
        x[i0 : i0 + len(c)] += c
        tt += rng.uniform(0.045, 0.085)
    write("typing.wav", reverb(np.stack([x, x], 1), 0.3, 0.12))


def thunk():
    m = int(0.9 * SR)
    s = np.arange(m) / SR
    f = 70 + 50 * np.exp(-s / 0.04)
    low = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-s / 0.18)
    blip = np.zeros(m)
    for k, (note, t0) in enumerate(((69, 0.02), (65, 0.14))):  # A4 → F4, falling = "look at this"
        i0 = int(t0 * SR)
        q = np.arange(m - i0) / SR
        blip[i0:] += (np.sin(2 * np.pi * hz(note) * q) + 0.3 * np.sin(2 * np.pi * 2 * hz(note) * q)) * np.exp(-q / 0.12) * 0.35
    x = low + lp(blip, 3000)
    write("thunk.wav", reverb(np.stack([x, x], 1), 0.8, 0.2))


def chime():
    m = int(1.8 * SR)
    x = np.zeros(m)
    for note, t0 in ((79, 0.0), (84, 0.08)):  # G5 → C6, rising = resolved
        i0 = int(t0 * SR)
        q = np.arange(m - i0) / SR
        f = hz(note)
        bell = np.sin(2 * np.pi * f * q) + 0.3 * np.sin(2 * np.pi * 2.0 * f * q) * np.exp(-q / 0.2) + 0.12 * np.sin(2 * np.pi * 3.01 * f * q) * np.exp(-q / 0.1)
        x[i0:] += bell * np.exp(-q / 0.55) * np.clip(q / 0.003, 0, 1)
    write("chime.wav", reverb(np.stack([x, x * 0.97], 1), 1.4, 0.3))


def whoosh():
    m = int(0.7 * SR)
    s = np.arange(m) / SR
    noise = rng.standard_normal(m)
    chunks = []
    for c in range(14):
        a, b = c * m // 14, (c + 1) * m // 14
        centre = 500 + 2200 * np.sin(np.pi * c / 13)
        chunks.append(bp(noise, centre * 0.6, centre * 1.4)[a:b])
    x = np.concatenate(chunks) * np.sin(np.pi * s / 0.7) ** 2
    pan = np.linspace(0.3, 0.7, m)
    write("whoosh.wav", reverb(np.stack([x * (1 - pan), x * pan], 1) * 2, 0.6, 0.2))


def pop():
    m = int(0.12 * SR)
    s = np.arange(m) / SR
    f = 520 + 380 * np.exp(-s / 0.01)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-s / 0.03)
    write("pop.wav", reverb(np.stack([x, x], 1), 0.4, 0.15))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    music()
    typing()
    thunk()
    chime()
    whoosh()
    pop()
    print(f"wrote {OUT} (total {TOTAL:.2f} s, scene starts {starts})")
