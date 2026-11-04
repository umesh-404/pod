"""Pod's sounds, synthesised from code.

    python -I windows/scripts/make-sounds.py            # writes windows/sounds/*.wav
    python -I windows/scripts/make-sounds.py --check    # also prints an analysis

Standard library only (wave, math, struct, random with fixed seeds), so it runs
on the system Python with nothing installed. Running it twice gives
byte-identical files.

(c) Pod contributors. The generated sounds are part of Pod and are covered by
the project's MIT License (see LICENSE at the repository root).

Format
    mono, 16-bit PCM, 48 000 Hz WAV. The island decodes them with WebAudio's
    decodeAudioData (src/core/sound.ts) and plays them through a master gain of
    0.12 by default; nothing in Rust decodes them.

Palette
    One voice family for Stew, a small friendly pea: round sine/triangle tones
    with a soft "mallet" overtone (kalimba / marimba-ish), little bubbly pitch
    glides, a breath of filtered noise where something physical happens, and a
    short, quiet room made of a few delays. Notes come from C major pentatonic
    so any two sounds that overlap still agree. Every sound fades in and out
    (no clicks), starts and ends on exactly zero, has no DC offset, and is
    scaled to the loudness (RMS over its audible part) the sound it replaces
    had, so the mix between quiet UI ticks and louder moments is unchanged.

Sounds (where they play -> intent)
    blip      UI tick (tab, toggle, small taps)    -> one tiny high droplet
    tick      sound switched back on               -> a smaller, woodier droplet
    hover     cursor over Stew                     -> an airy, barely-there rise
    pop       item added / saved / shelf drop      -> a bubble popping up
    peek      island peeks out (compact)           -> two quick rising droplets
    open      island expands                       -> a soft upward swell, two notes
    close     island collapses                     -> the same swell, falling
    error     anything failed                      -> a gentle low "uh-oh", two notes down
    approve   tab success                          -> two bright notes up
    approval  needs your OK (state)                -> a soft "ding-ding" asking
    question  question (state)                     -> a rising "hm?" with a wobble
    finish    job finished (state, focus end)      -> a three-note arpeggio and a sparkle
    work      working (state)                      -> a short, busy two-note "on it"
    think     thinking (state)                     -> two muted alternating notes, "hmm"
    search    searching (state)                    -> three quick rising scanning blips
    rate      rate limited (state)                 -> three steady notes stepping down
    sleep     sleeping (state)                     -> a slow, low descending breath
    dizzy     three slaps                          -> a wobbling, spiralling glide down
    greet     Stew says hi                         -> a cheerful two-note chirp
    greeting  first-run welcome                    -> a short welcome melody (~1.3 s)
    love      hovered long enough                  -> a warm FM bell, two notes, vibrato
    proud     proud emote                          -> a tiny three-note fanfare
    wink      wink emote                           -> a quick high sparkle
    yawn      yawn emote                           -> a breathy rise and fall
    annoyed   annoyed emote                        -> a muffled low "hmph"
    slap      Stew is tapped                       -> a soft padded thud, not a smack
    gulp      gulp animation                       -> a low bubble, down then up
    send      sending                              -> a light whoosh upward
    attach    attaching                            -> a soft two-part clip
"""

import math
import os
import random
import struct
import sys
import wave
import zlib

SR = 48000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sounds")

# Loudness of the sounds being replaced: dBFS RMS over their audible 10 ms
# windows (those above 1 % of the peak), measured from Coucou's files. Each new
# sound is scaled to its old one's number.
TARGET_DB = {
    "annoyed": -26.2, "approval": -21.2, "approve": -26.6, "attach": -24.9,
    "blip": -39.9, "close": -36.3, "dizzy": -24.1, "error": -20.7,
    "finish": -18.3, "greet": -20.9, "greeting": -24.8, "gulp": -21.2,
    "hover": -48.8, "love": -25.0, "open": -34.0, "peek": -31.3,
    "pop": -36.5, "proud": -21.6, "question": -22.7, "rate": -26.4,
    "search": -30.9, "send": -34.4, "slap": -30.6, "sleep": -33.5,
    "think": -30.2, "tick": -51.5, "wink": -42.3, "work": -34.4,
    "yawn": -28.8,
}
PEAK_CEILING_DB = -3.0

TAU = 2 * math.pi


def note(name):
    """'C5' -> Hz (A4 = 440)."""
    steps = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}
    letter, rest = name[0], name[1:]
    sharp = rest.startswith("#")
    octave = int(rest[1:] if sharp else rest)
    n = steps[letter] + (1 if sharp else 0) + (octave - 4) * 12
    return 440.0 * 2 ** (n / 12)


def silence(seconds):
    return [0.0] * int(round(seconds * SR))


def mix(dst, src, at=0.0, gain=1.0):
    """Adds src into dst starting at `at` seconds, growing dst as needed."""
    off = int(round(at * SR))
    need = off + len(src)
    if need > len(dst):
        dst.extend([0.0] * (need - len(dst)))
    for i, v in enumerate(src):
        dst[off + i] += v * gain
    return dst


def env_ad(n, attack, decay_tau):
    """Short attack (raised cosine), then exponential decay with time constant decay_tau."""
    a = max(1, int(attack * SR))
    out = []
    for i in range(n):
        if i < a:
            out.append(0.5 - 0.5 * math.cos(math.pi * i / a))
        else:
            out.append(math.exp(-(i - a) / (decay_tau * SR)))
    return out


def env_adsr(n, attack, decay, sustain, release):
    a, d, r = int(attack * SR), int(decay * SR), int(release * SR)
    out = []
    for i in range(n):
        if i < a:
            v = 0.5 - 0.5 * math.cos(math.pi * i / max(1, a))
        elif i < a + d:
            v = 1 - (1 - sustain) * (i - a) / max(1, d)
        else:
            v = sustain
        if i >= n - r:
            v *= (n - i) / max(1, r)
        out.append(v)
    return out


def tone(dur, f0, f1=None, glide="exp", partials=((1, 1.0),), attack=0.004,
         decay=0.08, vib_rate=0.0, vib_depth=0.0, env=None):
    """A pitched voice: summed sine partials over one phase, with an optional glide.

    partials: (ratio, amp) pairs; amp may be negative to flip phase. The upper
    partials die faster than the fundamental, like a struck bar.
    """
    n = len(env) if env is not None else int(round(dur * SR))
    f1 = f0 if f1 is None else f1
    e = env if env is not None else env_ad(n, attack, decay)
    out = []
    ph = 0.0
    for i in range(n):
        x = i / max(1, n - 1)
        if glide == "exp":
            f = f0 * (f1 / f0) ** x
        else:  # ease-out
            k = 1 - (1 - x) ** 3
            f = f0 + (f1 - f0) * k
        if vib_depth:
            f *= 1 + vib_depth * math.sin(TAU * vib_rate * i / SR)
        ph += f / SR
        t = i / SR
        v = 0.0
        for ratio, amp in partials:
            fade = 1.0 if ratio <= 1.01 else math.exp(-t * (18 + 10 * ratio))
            if f * ratio < SR * 0.45:
                v += amp * fade * math.sin(TAU * ph * ratio)
        out.append(v * e[i])
    return out


# The house voices.
MALLET = ((1, 1.0), (2, 0.18), (3.98, 0.12))     # round kalimba-ish note
SOFT = ((1, 1.0), (2, 0.08))                     # plain, rounder
BELL = ((1, 1.0), (2.76, 0.10), (5.4, 0.04))     # small, gentle bell
TRI = ((1, 1.0), (3, -1 / 9), (5, 1 / 25), (7, -1 / 49))  # triangle, softened


def fm(dur, fc, ratio, index, attack=0.005, decay=0.2, index_decay=0.08,
       vib_rate=0.0, vib_depth=0.0):
    """Soft two-operator FM: the brightness fades faster than the note."""
    n = int(round(dur * SR))
    e = env_ad(n, attack, decay)
    out = []
    pc = pm = 0.0
    for i in range(n):
        t = i / SR
        f = fc * (1 + vib_depth * math.sin(TAU * vib_rate * t)) if vib_depth else fc
        pc += f / SR
        pm += f * ratio / SR
        idx = index * math.exp(-t / index_decay)
        out.append(e[i] * math.sin(TAU * pc + idx * math.sin(TAU * pm)))
    return out


class SVF:
    """Chamberlin state-variable filter (stable for the low cutoffs used here)."""

    def __init__(self, q=0.7):
        self.low = self.band = 0.0
        self.damp = 1 / q

    def step(self, x, fc):
        f = 2 * math.sin(math.pi * min(fc, SR / 6) / SR)
        self.low += f * self.band
        high = x - self.low - self.damp * self.band
        self.band += f * high
        return self.low, self.band, high


def noise(dur, rng, f0, f1=None, q=1.2, mode="band", attack=0.004, decay=0.05, env=None):
    """Filtered white noise with a cutoff sweep from f0 to f1."""
    n = len(env) if env is not None else int(round(dur * SR))
    f1 = f0 if f1 is None else f1
    e = env if env is not None else env_ad(n, attack, decay)
    flt = SVF(q)
    out = []
    for i in range(n):
        x = i / max(1, n - 1)
        fc = f0 * (f1 / f0) ** x
        lo, bp, hi = flt.step(rng.uniform(-1, 1), fc)
        v = {"band": bp, "low": lo, "high": hi}[mode]
        out.append(v * e[i])
    return out


def room(sig, mix_amt=0.12, size=1.0, tail=0.12):
    """A small, dark room: three feedback delays plus a one-pole lowpass, then a tail."""
    sig = sig + silence(tail)
    out = list(sig)
    for ms, fb in ((23.0, 0.42), (31.7, 0.38), (41.3, 0.33)):
        d = int(ms * size * SR / 1000)
        buf = [0.0] * len(sig)
        lp = 0.0
        for i in range(len(sig)):
            y = sig[i] + (buf[i - d] * fb if i >= d else 0.0)
            lp += 0.35 * (y - lp)
            buf[i] = lp
        for i in range(len(sig)):
            out[i] += buf[i] * mix_amt / 3
    return out


def finish_signal(sig, fade_in=0.002, fade_out=0.012):
    """High-pass away DC, fade both ends, and pin the first and last sample to 0."""
    # One-pole DC blocker (~20 Hz).
    r = 1 - TAU * 20 / SR
    y_prev = x_prev = 0.0
    out = []
    for x in sig:
        y = x - x_prev + r * y_prev
        x_prev, y_prev = x, y
        out.append(y)
    # Trim trailing near-silence (below -80 dB of the peak) so files stay small.
    pk = max(abs(v) for v in out) or 1.0
    end = len(out)
    while end > 1 and abs(out[end - 1]) < pk * 1e-4:
        end -= 1
    out = out[: end + int(0.004 * SR)]
    n = len(out)
    fi, fo = max(1, int(fade_in * SR)), max(1, int(fade_out * SR))
    for i in range(min(fi, n)):
        out[i] *= 0.5 - 0.5 * math.cos(math.pi * i / fi)
    for i in range(min(fo, n)):
        out[n - 1 - i] *= 0.5 - 0.5 * math.cos(math.pi * i / fo)
    out[0] = 0.0
    out[-1] = 0.0
    w = _window(n)
    k = (sum(out) / n) / ((sum(w) / n) or 1.0)
    return [v - k * wi for v, wi in zip(out, w)]


def _window(n):
    """Hann window: removes any leftover DC without moving the zero endpoints."""
    return [0.5 - 0.5 * math.cos(TAU * i / (n - 1)) for i in range(n)] if n > 1 else [0.0]


def active_rms(sig):
    """RMS over the 10 ms windows louder than 1 % of the peak (the audible part)."""
    pk = max(abs(v) for v in sig) or 1.0
    win = SR // 100
    acc = []
    for i in range(0, len(sig) - win, win):
        r = math.sqrt(sum(v * v for v in sig[i : i + win]) / win)
        if r > pk * 0.01:
            acc.append(r)
    return math.sqrt(sum(r * r for r in acc) / len(acc)) if acc else 0.0


def db(v):
    return 20 * math.log10(v) if v > 0 else -999.0


# ── The sounds ────────────────────────────────────────────────────────────────


def s_blip(rng):
    return room(tone(0.06, note("A6"), note("C7"), partials=SOFT, attack=0.002, decay=0.014), 0.06, 0.6, 0.03)


def s_tick(rng):
    sig = tone(0.04, note("E7"), partials=SOFT, attack=0.001, decay=0.007)
    mix(sig, noise(0.02, rng, 3500, q=2.0, attack=0.0008, decay=0.004), 0, 0.25)
    return sig


def s_hover(rng):
    return tone(0.08, note("E6"), note("G6"), partials=SOFT, attack=0.018, decay=0.025)


def s_pop(rng):
    sig = tone(0.12, note("C5"), note("C6"), glide="ease", partials=SOFT, attack=0.002, decay=0.03)
    mix(sig, noise(0.015, rng, 2200, q=1.5, attack=0.001, decay=0.004), 0, 0.15)
    return room(sig, 0.08, 0.7, 0.05)


def s_peek(rng):
    sig = tone(0.07, note("G5"), note("A5"), partials=MALLET, attack=0.002, decay=0.025)
    mix(sig, tone(0.10, note("C6"), note("D6"), partials=MALLET, attack=0.002, decay=0.035), 0.065)
    return room(sig, 0.10, 0.8, 0.06)


def s_open(rng):
    sig = tone(0.16, note("G4"), note("C5"), glide="ease", partials=SOFT, attack=0.02, decay=0.07)
    mix(sig, tone(0.16, note("E5"), partials=MALLET, attack=0.006, decay=0.06), 0.07, 0.7)
    return room(sig, 0.12, 1.0, 0.07)


def s_close(rng):
    sig = tone(0.16, note("E5"), note("C5"), glide="ease", partials=SOFT, attack=0.012, decay=0.06)
    mix(sig, tone(0.15, note("G4"), partials=MALLET, attack=0.006, decay=0.05), 0.06, 0.7)
    return room(sig, 0.10, 1.0, 0.06)


def s_error(rng):
    a = tone(0.14, note("E4"), note("D4"), partials=TRI, attack=0.006, decay=0.07)
    b = tone(0.20, note("C4"), note("A3"), glide="ease", partials=TRI, attack=0.006, decay=0.09)
    b2 = tone(0.20, note("C4") * 1.004, note("A3") * 1.004, glide="ease", partials=SOFT, attack=0.006, decay=0.09)
    sig = mix(a, b, 0.11)
    mix(sig, b2, 0.11, 0.4)
    return room(sig, 0.10, 1.0, 0.07)


def s_approve(rng):
    sig = tone(0.10, note("G5"), partials=MALLET, attack=0.003, decay=0.05)
    mix(sig, tone(0.18, note("C6"), partials=MALLET, attack=0.003, decay=0.08), 0.08)
    return room(sig, 0.12, 1.0, 0.08)


def s_approval(rng):
    sig = tone(0.12, note("A5"), partials=BELL, attack=0.003, decay=0.06)
    mix(sig, tone(0.22, note("A5"), note("C6"), glide="ease", partials=BELL, attack=0.003, decay=0.09), 0.13)
    return room(sig, 0.12, 1.0, 0.08)


def s_question(rng):
    sig = tone(0.24, note("D5"), note("A5"), glide="ease", partials=SOFT, attack=0.015,
               decay=0.10, vib_rate=9, vib_depth=0.008)
    return room(sig, 0.10, 0.9, 0.06)


def s_finish(rng):
    sig = []
    for k, (nm, at) in enumerate((("C5", 0.0), ("E5", 0.07), ("G5", 0.14))):
        mix(sig, tone(0.22, note(nm), partials=MALLET, attack=0.003, decay=0.09), at, 0.85)
    mix(sig, tone(0.30, note("C6"), partials=BELL, attack=0.003, decay=0.12), 0.21)
    mix(sig, tone(0.14, note("G6"), note("C7"), partials=SOFT, attack=0.004, decay=0.05), 0.24, 0.25)
    return room(sig, 0.14, 1.1, 0.10)


def s_work(rng):
    sig = tone(0.07, note("D5"), partials=MALLET, attack=0.002, decay=0.03)
    mix(sig, tone(0.10, note("G5"), partials=MALLET, attack=0.002, decay=0.04), 0.06)
    return room(sig, 0.08, 0.8, 0.05)


def s_think(rng):
    sig = tone(0.12, note("E5"), partials=SOFT, attack=0.01, decay=0.05)
    mix(sig, tone(0.16, note("D5"), partials=SOFT, attack=0.01, decay=0.06), 0.11)
    return room(sig, 0.10, 1.0, 0.06)


def s_search(rng):
    sig = []
    for k, nm in enumerate(("C6", "D6", "E6")):
        mix(sig, tone(0.06, note(nm), partials=SOFT, attack=0.002, decay=0.018), k * 0.06)
    mix(sig, noise(0.18, rng, 1800, 5000, q=1.8, attack=0.03, decay=0.05), 0, 0.08)
    return room(sig, 0.10, 0.9, 0.05)


def s_rate(rng):
    sig = []
    for k, nm in enumerate(("G5", "E5", "D5")):
        mix(sig, tone(0.13, note(nm), partials=SOFT, attack=0.006, decay=0.05), k * 0.10)
    return room(sig, 0.10, 1.0, 0.06)


def s_sleep(rng):
    n = int(0.42 * SR)
    sig = tone(0.42, note("G4"), note("C4"), partials=SOFT, env=env_adsr(n, 0.08, 0.1, 0.6, 0.2))
    mix(sig, noise(0.40, rng, 900, 500, q=0.8, mode="low", env=env_adsr(int(0.40 * SR), 0.12, 0.1, 0.5, 0.2)), 0.02, 0.10)
    return room(sig, 0.08, 1.0, 0.05)


def s_dizzy(rng):
    n = int(0.60 * SR)
    sig = tone(0.60, note("A5"), note("C5"), partials=SOFT, env=env_adsr(n, 0.01, 0.15, 0.6, 0.25),
               vib_rate=7, vib_depth=0.045)
    mix(sig, tone(0.60, note("E5"), note("G4"), partials=SOFT, env=env_adsr(n, 0.01, 0.15, 0.5, 0.25),
                  vib_rate=6.3, vib_depth=0.05), 0.0, 0.35)
    return room(sig, 0.10, 1.0, 0.06)


def s_greet(rng):
    sig = tone(0.09, note("E5"), note("G5"), glide="ease", partials=MALLET, attack=0.003, decay=0.04)
    mix(sig, tone(0.18, note("C6"), note("D6"), glide="ease", partials=MALLET, attack=0.003, decay=0.07), 0.08)
    return room(sig, 0.12, 1.0, 0.07)


def s_greeting(rng):
    # A little "hello there, I'm here": a rising pentatonic phrase, a glide,
    # then a two-note bell to land on. The greeting view fades it out early if
    # it ends sooner (Sound.fadeOut in src/mochi/greeting.ts).
    sig = []
    phrase = (("C5", 0.00), ("D5", 0.09), ("E5", 0.18), ("G5", 0.27), ("A5", 0.40))
    for nm, at in phrase:
        mix(sig, tone(0.28, note(nm), partials=MALLET, attack=0.004, decay=0.11), at, 0.8)
    mix(sig, tone(0.30, note("A5"), note("C6"), glide="ease", partials=SOFT, attack=0.02, decay=0.10), 0.60, 0.6)
    mix(sig, tone(0.10, note("G5"), partials=MALLET, attack=0.003, decay=0.04), 0.84, 0.6)
    mix(sig, tone(0.28, note("E6"), partials=BELL, attack=0.003, decay=0.11), 0.96, 0.7)
    mix(sig, tone(0.28, note("C6"), partials=BELL, attack=0.003, decay=0.12), 0.96, 0.6)
    # Soft pad underneath so the phrase reads as one gesture.
    n = int(1.15 * SR)
    mix(sig, tone(1.15, note("C4"), partials=SOFT, env=env_adsr(n, 0.25, 0.3, 0.5, 0.5)), 0.0, 0.18)
    mix(sig, tone(1.15, note("G4"), partials=SOFT, env=env_adsr(n, 0.35, 0.3, 0.4, 0.5)), 0.0, 0.12)
    return room(sig, 0.14, 1.2, 0.10)


def s_love(rng):
    sig = fm(0.26, note("E5"), 2.0, 1.2, decay=0.12, index_decay=0.05, vib_rate=6, vib_depth=0.006)
    mix(sig, fm(0.34, note("G5"), 2.0, 1.0, decay=0.15, index_decay=0.06, vib_rate=6, vib_depth=0.008), 0.13)
    return room(sig, 0.14, 1.1, 0.09)


def s_proud(rng):
    sig = []
    for nm, at, d in (("G5", 0.0, 0.05), ("C6", 0.07, 0.05), ("E6", 0.14, 0.12)):
        mix(sig, tone(d * 3, note(nm), partials=MALLET, attack=0.003, decay=d), at)
    mix(sig, tone(0.30, note("C5"), partials=SOFT, attack=0.01, decay=0.10), 0.14, 0.35)
    return room(sig, 0.12, 1.0, 0.08)


def s_wink(rng):
    sig = tone(0.09, note("C7"), note("E7"), partials=SOFT, attack=0.003, decay=0.025)
    mix(sig, tone(0.07, note("G7"), partials=SOFT, attack=0.002, decay=0.018), 0.045, 0.4)
    return room(sig, 0.08, 0.6, 0.04)


def s_yawn(rng):
    n = int(0.48 * SR)
    sig = []
    ph = 0.0
    e = env_adsr(n, 0.08, 0.1, 0.7, 0.22)
    for i in range(n):
        x = i / n
        f = note("C5") * (1 + 0.25 * math.sin(math.pi * min(1, x * 1.6))) * (1 - 0.25 * x)
        ph += f / SR
        sig.append(e[i] * (math.sin(TAU * ph) + 0.08 * math.sin(2 * TAU * ph)))
    mix(sig, noise(0.46, rng, 700, 1400, q=0.9, env=env_adsr(int(0.46 * SR), 0.1, 0.1, 0.6, 0.2)), 0.01, 0.25)
    return room(sig, 0.08, 1.0, 0.05)


def s_annoyed(rng):
    a = tone(0.08, note("D4"), partials=TRI, attack=0.004, decay=0.04)
    b = tone(0.14, note("A3"), note("G3"), partials=TRI, attack=0.004, decay=0.06)
    sig = mix(a, b, 0.075)
    mix(sig, noise(0.08, rng, 600, q=0.8, mode="low", attack=0.004, decay=0.03), 0.075, 0.15)
    return room(sig, 0.06, 0.8, 0.04)


def s_slap(rng):
    sig = tone(0.12, 230, 110, glide="ease", partials=SOFT, attack=0.0015, decay=0.04)
    mix(sig, noise(0.05, rng, 1400, 500, q=0.8, mode="low", attack=0.0008, decay=0.012), 0, 0.5)
    return room(sig, 0.06, 0.6, 0.03)


def s_gulp(rng):
    sig = tone(0.08, note("G4"), note("C4"), glide="ease", partials=SOFT, attack=0.004, decay=0.04)
    mix(sig, tone(0.12, note("A3"), note("E4"), glide="ease", partials=SOFT, attack=0.003, decay=0.05), 0.08)
    return room(sig, 0.08, 0.8, 0.04)


def s_send(rng):
    sig = noise(0.20, rng, 600, 4500, q=1.6, attack=0.06, decay=0.07)
    mix(sig, tone(0.14, note("C5"), note("C6"), glide="ease", partials=SOFT, attack=0.02, decay=0.05), 0.05, 0.6)
    return room(sig, 0.08, 0.9, 0.05)


def s_attach(rng):
    sig = tone(0.06, note("E6"), partials=MALLET, attack=0.0015, decay=0.016)
    mix(sig, noise(0.012, rng, 3000, q=2.0, attack=0.0008, decay=0.003), 0, 0.3)
    mix(sig, tone(0.10, note("A5"), partials=MALLET, attack=0.0015, decay=0.03), 0.07)
    mix(sig, noise(0.012, rng, 2400, q=2.0, attack=0.0008, decay=0.003), 0.07, 0.3)
    return room(sig, 0.08, 0.8, 0.05)


SOUNDS = {name[2:]: fn for name, fn in globals().items() if name.startswith("s_")}


def render(name):
    rng = random.Random(zlib.crc32(name.encode()))
    sig = finish_signal(SOUNDS[name](rng))
    g = 10 ** (TARGET_DB[name] / 20) / (active_rms(sig) or 1.0)
    pk = max(abs(v) for v in sig) * g
    ceiling = 10 ** (PEAK_CEILING_DB / 20)
    if pk > ceiling:
        g *= ceiling / pk
    return [v * g for v in sig]


def write(path, sig):
    frames = b"".join(struct.pack("<h", max(-32767, min(32767, int(round(v * 32767))))) for v in sig)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)


def analyse(name, path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        raw = w.readframes(n)
    s = [v / 32768 for v in struct.unpack("<%dh" % n, raw)]
    pk = max(abs(v) for v in s)
    dc = sum(s) / n
    clipped = sum(1 for v in s if abs(v) >= 32766 / 32768)
    # Spectral centroid via a few Goertzel bins (cheap "spectrogram-ish" summary).
    bands = (250, 500, 1000, 2000, 4000, 8000)
    pw = []
    for f in bands:
        k = 2 * math.cos(TAU * f / SR)
        s1 = s2 = 0.0
        for v in s:
            s0 = v + k * s1 - s2
            s2, s1 = s1, s0
        pw.append(s1 * s1 + s2 * s2 - k * s1 * s2)
    tot = sum(pw) or 1
    centroid = sum(f * p for f, p in zip(bands, pw)) / tot
    print(f"{name:9s} {n / SR * 1000:5.0f} ms  peak {db(pk):6.1f}  activeRMS {db(active_rms(s)):6.1f} "
          f"(target {TARGET_DB[name]:6.1f})  dc {dc:+.5f}  ends {s[0]:+.0f}/{s[-1]:+.0f}  "
          f"clipped {clipped}  centroid~{centroid:5.0f} Hz")


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in sorted(SOUNDS):
        path = os.path.join(OUT, name + ".wav")
        write(path, render(name))
        if "--check" in sys.argv:
            analyse(name, path)
    print(f"wrote {len(SOUNDS)} sounds to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
