import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { Activity, SessionProblem, Turn } from '../hooks/useSreConversation';

interface Props {
  activity: Activity;
  muted: boolean;
  turns: Turn[];
  problem: SessionProblem | null;
  inSession: boolean;
  agentName: string;
  onToggleSession: () => void;
  onExit: () => void;
  getOutputVolume: () => number;
  getInputVolume: () => number;
  getOutputFrequency: () => Uint8Array;
}

/**
 * Full-screen presence mode: black, Paige as a ring of voice in the middle,
 * and what she says as subtitles underneath. Nothing else is drawn.
 *
 * Entering the stage starts the session. The ring is the only control after
 * that — click, Space or Enter ends it or starts it again — and Escape leaves
 * the stage. Everything the console shows is
 * still being collected behind it, so leaving loses nothing.
 */
export function Stage({
  activity,
  muted,
  turns,
  problem,
  inSession,
  agentName,
  onToggleSession,
  onExit,
  getOutputVolume,
  getInputVolume,
  getOutputFrequency,
}: Props) {
  const orbRef = useRef<HTMLButtonElement>(null);

  // Browser fullscreen is requested by whoever opens the stage, inside the
  // click (see `enterBrowserFullscreen`). Leaving it leaves the stage too, since
  // the browser swallows the Escape that did it.
  useEffect(() => {
    orbRef.current?.focus();
    const onChange = () => {
      if (!fullscreenElement()) onExit();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
      exitBrowserFullscreen();
    };
  }, [onExit]);

  const label = inSession ? `End the session with ${agentName}` : `Start a session with ${agentName}`;

  return (
    <div className="stage fixed inset-0 z-50 overflow-hidden bg-black">
      {/* Full-bleed, so the bloom and the drifting light are never clipped. */}
      <VoiceRing
        activity={activity}
        muted={muted}
        getOutputVolume={getOutputVolume}
        getInputVolume={getInputVolume}
        getOutputFrequency={getOutputFrequency}
      />

      {/* The hit area is the ring itself, dead centre on the screen. */}
      <button
        ref={orbRef}
        type="button"
        onClick={onToggleSession}
        aria-label={label}
        title={label}
        className="stage-orb absolute left-1/2 top-1/2 aspect-square w-[calc(var(--ring-r)*2)] -translate-x-1/2 -translate-y-1/2 rounded-full focus:outline-none"
      />

      <img
        src="/brand/pagerduty-wordmark.png"
        alt="PagerDuty"
        draggable={false}
        className="pointer-events-none absolute bottom-[4vmin] left-[4vmin] h-[clamp(18px,2.6vmin,30px)] w-auto select-none opacity-80"
      />

      <div className="absolute inset-x-0 bottom-0 top-[calc(50%+var(--ring-r)+2vh)] flex flex-col items-center">
        <Subtitles turns={turns} problem={problem} idle={activity === 'offline'} agentName={agentName} />
      </div>
    </div>
  );
}

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

function fullscreenElement(): Element | null {
  const doc = document as WebkitDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Must be called synchronously inside the click that opens the stage. Browsers
 * only grant fullscreen to a request made while handling a user gesture, and
 * Safari is strict about it — requested from an effect after render, or after
 * the microphone prompt, it is silently refused.
 */
export function enterBrowserFullscreen(): void {
  if (fullscreenElement()) return;
  const root = document.documentElement as WebkitElement;
  try {
    if (root.requestFullscreen) void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    else root.webkitRequestFullscreen?.();
  } catch {
    // Refused (an iframe without allow="fullscreen", say). The stage still
    // covers the window.
  }
}

function exitBrowserFullscreen(): void {
  if (!fullscreenElement()) return;
  const doc = document as WebkitDocument;
  if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
  else doc.webkitExitFullscreen?.();
}

/* ------------------------------------------------------------------------ */
/* The ring                                                                  */
/* ------------------------------------------------------------------------ */

const GREEN = [6, 172, 56] as const;
const GREEN_DEEP = [6, 70, 30] as const;
const MINT = [120, 255, 160] as const;

/** A few motes start bright, so the drift reads as light rather than dust. */
const freshMote = (drift: number) => drift < 0.15;
const GREY = [69, 78, 86] as const;

/** Integer harmonics keep every wave a closed loop around the circle. */
const HARMONICS = [
  { k: 4, speed: 0.9, weight: 0.35 },
  { k: 9, speed: -1.4, weight: 0.7 },
  { k: 14, speed: 2.1, weight: 0.6 },
  { k: 22, speed: -2.9, weight: 0.4 },
];

const LINES = 8;

/** Ring radius as a share of the shorter screen side; mirrored by `--ring-r`. */
const RING = 0.2;

interface Mote {
  angle: number;
  drift: number;
  speed: number;
  size: number;
}

function rgba(c: readonly number[], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/**
 * Paige as a ring of voice. Full-bleed on the stage; also used small, as her
 * avatar in the console header, where `radius` is a larger share of a small box.
 */
export function VoiceRing({
  activity,
  muted,
  getOutputVolume,
  getInputVolume,
  getOutputFrequency,
  radius = RING,
  moteCount = 90,
}: Pick<Props, 'activity' | 'muted' | 'getOutputVolume' | 'getInputVolume' | 'getOutputFrequency'> & {
  /** Ring radius as a share of the canvas's shorter side. */
  radius?: number;
  moteCount?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The draw loop reads these through a ref so it never restarts on a render.
  const live = useRef({ activity, muted, getOutputVolume, getInputVolume, getOutputFrequency });
  live.current = { activity, muted, getOutputVolume, getInputVolume, getOutputFrequency };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = performance.now();
    let t = 0;
    let level = 0;
    const bands = HARMONICS.map(() => 0);
    const motes: Mote[] = Array.from({ length: moteCount }, () => ({
      angle: Math.random() * Math.PI * 2,
      drift: Math.random(),
      speed: 0.05 + Math.random() * 0.12,
      size: 0.6 + Math.random() * 1.4,
    }));

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const read = (fn: () => number): number => {
      try {
        const v = fn();
        return Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const still = reduced.matches;
      if (!still) t += dt;

      const s = live.current;
      const speaking = s.activity === 'speaking';
      const listening = s.activity === 'listening' && !s.muted;

      // What the ring should be doing right now, before smoothing.
      let target: number;
      if (speaking) target = Math.min(1, read(s.getOutputVolume) * 1.8);
      else if (listening) target = Math.min(0.5, read(s.getInputVolume) * 1.2);
      else if (s.activity === 'thinking') target = 0.1 + 0.04 * Math.sin(t * 2.2);
      else if (s.activity === 'connecting') target = 0.06;
      else target = 0.025;
      level += (target - level) * (target > level ? 0.3 : 0.07);

      // Spread the voice's spectrum across the harmonics so different parts of
      // her voice move different parts of the ring.
      let freq: Uint8Array | null = null;
      if (speaking) {
        try {
          freq = s.getOutputFrequency();
        } catch {
          freq = null;
        }
      }
      for (let i = 0; i < bands.length; i++) {
        let b = 0.55;
        if (freq && freq.length) {
          const span = Math.floor(freq.length / 2 / bands.length) || 1;
          let sum = 0;
          for (let j = i * span; j < (i + 1) * span; j++) sum += freq[j] ?? 0;
          b = 0.25 + (sum / span / 255) * 1.2;
        }
        bands[i] += (b - bands[i]) * 0.15;
      }

      const { width, height } = canvas.getBoundingClientRect();
      const cx = width / 2;
      const cy = height / 2;
      const R = Math.min(width, height) * radius;
      // Glow and spacing are tuned for the stage's ring; a small ring keeps
      // its proportions instead of drowning in its own bloom.
      const k = Math.max(0.35, Math.min(1, R / 216));
      const tone = s.muted && s.activity !== 'offline' ? GREY : GREEN;
      const core = s.muted && s.activity !== 'offline' ? GREY : MINT;
      const dim = s.activity === 'offline' ? 0.5 : 1;

      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      // Two blooms: a wide, faint one that fills the room, and a tighter one
      // hugging the ring. Both swell with her voice.
      const wide = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 2.6);
      wide.addColorStop(0, rgba(s.muted ? GREY : GREEN_DEEP, (0.1 + level * 0.25) * dim));
      wide.addColorStop(1, rgba(GREEN_DEEP, 0));
      ctx.fillStyle = wide;
      ctx.fillRect(0, 0, width, height);

      const tight = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.35);
      tight.addColorStop(0, rgba(GREEN_DEEP, 0));
      tight.addColorStop(0.42, rgba(s.muted ? GREY : GREEN_DEEP, (0.22 + level * 0.55) * dim));
      tight.addColorStop(1, rgba(GREEN_DEEP, 0));
      ctx.fillStyle = tight;
      ctx.fillRect(0, 0, width, height);

      // Halo: two dotted dials turning in opposite directions, pushed outward
      // a little by the voice. Instrument, not decoration — they still when she
      // is offline.
      if (!still) {
        ctx.save();
        ctx.lineCap = 'round';
        for (const [scale, dash, dir, alpha] of [
          [1.2, [1, 9], 1, 0.35],
          [1.32, [1, 22], -1, 0.22],
        ] as const) {
          ctx.beginPath();
          ctx.arc(cx, cy, R * (scale + level * 0.06), 0, Math.PI * 2);
          ctx.setLineDash(dash as unknown as number[]);
          ctx.lineDashOffset = dir * t * 14 * k;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = rgba(tone, alpha * dim);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Motes: light shed from the ring, drifting outward faster the louder she
      // is, fading as they go.
      if (!still) {
        for (const m of motes) {
          m.drift += m.speed * dt * (0.25 + level * 3.5);
          if (m.drift > 1) {
            m.drift = 0;
            m.angle = Math.random() * Math.PI * 2;
          }
          const r = R * (1.02 + m.drift * 0.75);
          const a = m.angle + m.drift * 0.4;
          const alpha = Math.sin(m.drift * Math.PI) * (0.15 + level * 0.85) * dim;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, m.size * k, 0, Math.PI * 2);
          ctx.fillStyle = rgba(freshMote(m.drift) ? core : tone, alpha);
          ctx.fill();
        }
      }

      // The waves. Amplitude is the voice; under reduced motion it stays flat
      // and only the light changes. Drawn back to front so the bright core line
      // sits on top of the softer echoes.
      const amp = still ? 0 : R * (0.02 + level * 0.16);
      const steps = 420;
      for (let line = LINES - 1; line >= 0; line--) {
        const falloff = 1 - line * 0.09;
        const offset = line * 0.55;
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const th = (i / steps) * Math.PI * 2;
          let w = 0;
          for (let h = 0; h < HARMONICS.length; h++) {
            const { k, speed, weight } = HARMONICS[h];
            w += Math.sin(k * th + speed * t * (1 + line * 0.06) + offset * (h + 1)) * bands[h] * weight;
          }
          const r = R + amp * falloff * w;
          const x = cx + Math.cos(th) * r;
          const y = cy + Math.sin(th) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        if (line === 0) {
          // The core line glows: a blurred pass, then a crisp one on top.
          ctx.shadowColor = rgba(GREEN, 0.9 * dim);
          ctx.shadowBlur = (14 + level * 36) * k;
          ctx.lineWidth = 2.4;
          ctx.strokeStyle = rgba(core, 0.95 * dim);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = rgba([235, 255, 240], 0.55 * dim);
          ctx.stroke();
        } else {
          ctx.lineWidth = 1;
          ctx.strokeStyle = rgba(tone, (0.5 - line * 0.055) * dim);
          ctx.stroke();
        }
      }

      // Thinking and connecting: a bright comet travelling round the ring.
      if ((s.activity === 'thinking' || s.activity === 'connecting') && !still) {
        const a = t * (s.activity === 'connecting' ? 3.2 : 1.6);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.shadowColor = rgba(GREEN, 0.9);
        ctx.shadowBlur = 24 * k;
        for (let k = 0; k < 6; k++) {
          ctx.beginPath();
          ctx.arc(cx, cy, R, a - k * 0.12, a - k * 0.12 + 0.14);
          ctx.lineWidth = 4 - k * 0.5;
          ctx.strokeStyle = rgba(core, 0.95 - k * 0.15);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.globalCompositeOperation = 'source-over';
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}

/* ------------------------------------------------------------------------ */
/* Subtitles                                                                 */
/* ------------------------------------------------------------------------ */

interface Cue {
  id: string;
  text: string;
  tone: 'speech' | 'hint' | 'problem';
  /** How long the cue is on screen; the word reveal is paced against it. */
  ms: number;
}

/** Roughly her speaking rate at the default voice speed. */
const MS_PER_CHAR = 72;
const MIN_CUE_MS = 1800;
const MAX_CUE_CHARS = 90;
const QUESTION_HOLD_MS = 15_000;
const QUESTION_AFTER_REPLY_MS = 5_000;

/** Sentences, packed into cues short enough to read at a glance. */
function chunk(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cues: string[] = [];
  for (const sentence of sentences) {
    const prev = cues[cues.length - 1];
    if (prev && prev.length + sentence.length + 1 <= MAX_CUE_CHARS) cues[cues.length - 1] = `${prev} ${sentence}`;
    else cues.push(sentence);
  }
  return cues;
}

function Subtitles({
  turns,
  problem,
  idle,
  agentName,
}: {
  turns: Turn[];
  problem: SessionProblem | null;
  idle: boolean;
  agentName: string;
}) {
  const [cue, setCue] = useState<Cue | null>(null);
  const queue = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = useRef<{ id: string; consumed: number }>({ id: '', consumed: 0 });
  const seq = useRef(0);

  /**
   * What the engineer just asked, as it was heard. Shown above her answer so a
   * room watching can follow both sides, and so a mis-hearing is obvious
   * before she answers the wrong question.
   */
  const [question, setQuestion] = useState<{ id: string; text: string } | null>(null);
  const questionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropQuestionIn = (ms: number) => {
    if (questionTimer.current) clearTimeout(questionTimer.current);
    questionTimer.current = setTimeout(() => setQuestion(null), ms);
  };

  const play = () => {
    if (timer.current) return;
    const next = queue.current.shift();
    if (next === undefined) {
      setCue(null);
      return;
    }
    const ms = Math.max(MIN_CUE_MS, next.length * MS_PER_CHAR);
    setCue({ id: `cue-${seq.current++}`, text: next, tone: 'speech', ms });
    timer.current = setTimeout(() => {
      timer.current = null;
      play();
    }, ms);
  };

  // Follow the newest turn. Agent text can grow in place, so only the part not
  // yet queued is chunked; anything the engineer says cuts her subtitles off,
  // as it cuts her off.
  const latest = turns[turns.length - 1];
  useEffect(() => {
    if (!latest || latest.role === 'system') return;
    if (latest.role === 'user') {
      setQuestion({ id: latest.id, text: latest.text });
      // Held while she thinks; her reply shortens this.
      dropQuestionIn(QUESTION_HOLD_MS);
      queue.current = [];
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      source.current = { id: latest.id, consumed: 0 };
      setCue(null);
      return;
    }
    if (source.current.id !== latest.id) {
      // She has started answering: let the question linger a moment, then go.
      dropQuestionIn(QUESTION_AFTER_REPLY_MS);
      queue.current = [];
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      source.current = { id: latest.id, consumed: 0 };
    }
    const fresh = latest.text.slice(source.current.consumed);
    source.current.consumed = latest.text.length;
    if (!fresh.trim()) return;
    queue.current.push(...chunk(fresh));
    play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.text]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (questionTimer.current) clearTimeout(questionTimer.current);
  }, []);

  // A problem is the one thing worth interrupting her subtitles for.
  const shown: Cue | null = problem
    ? { id: `problem-${problem.message}`, text: problem.message, tone: 'problem', ms: 0 }
    : cue ?? (idle ? { id: 'hint', text: `Touch the ring to talk to ${agentName} again`, tone: 'hint', ms: 0 } : null);

  return (
    <>
    <div className="pointer-events-none relative h-[clamp(36px,6vh,64px)] w-full shrink-0 px-6" aria-live="polite">
      <AnimatePresence initial={false}>
        {question && <Question key={question.id} text={question.text} />}
      </AnimatePresence>
    </div>
    <div
      className="pointer-events-none relative h-[clamp(140px,24vh,260px)] w-full shrink-0 px-6"
      aria-live="polite"
    >
      {/* No `mode="wait"`: the outgoing line drifts away while the next one is
          already arriving, the way film subtitles overlap for a beat. */}
      <AnimatePresence initial={false}>
        {shown && <Line key={shown.id} cue={shown} />}
      </AnimatePresence>
    </div>
    </>
  );
}

/** The engineer's words, quieter than hers: smaller, dimmer, in quotes. */
function Question({ text }: { text: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.p
      className="absolute inset-x-0 bottom-0 mx-auto line-clamp-2 max-w-[48ch] text-center text-[clamp(17px,2.7vmin,28px)] font-light italic leading-snug text-[#7f8d93]"
      initial={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)', y: 6 }}
      animate={
        reduced
          ? { opacity: 1 }
          : { opacity: 1, filter: 'blur(0px)', y: 0, transition: { duration: 0.5, ease: 'easeOut' } }
      }
      exit={
        reduced
          ? { opacity: 0, transition: { duration: 0.4 } }
          : { opacity: 0, filter: 'blur(8px)', y: -10, transition: { duration: 0.9, ease: 'easeOut' } }
      }
    >
      {'\u201C'}
      {text}
      {'\u201D'}
    </motion.p>
  );
}

const SPEECH_TYPE =
  'text-[clamp(22px,3.4vmin,44px)] font-light leading-[1.18] tracking-[-0.012em] text-[#eef3f2]';

/**
 * One subtitle. Speech arrives word by word, paced to roughly when she says
 * each one: every word resolves out of a soft blur with a brief green glow,
 * then settles to white. On its way out the whole line lifts and blurs away.
 */
function Line({ cue }: { cue: Cue }) {
  const reduced = useReducedMotion();

  const leave = reduced
    ? { opacity: 0, transition: { duration: 0.4 } }
    : { opacity: 0, y: -32, filter: 'blur(12px)', transition: { duration: 0.7, ease: [0.4, 0, 0.2, 1] as const } };

  const frame = 'absolute inset-x-0 top-0 mx-auto text-center';

  if (cue.tone !== 'speech') {
    return (
      <motion.p
        className={`${frame} max-w-[36ch] ${
          cue.tone === 'problem'
            ? 'text-[clamp(18px,2.6vmin,26px)] font-light text-warn'
            : 'text-[clamp(15px,2vmin,20px)] font-light tracking-[0.04em] text-[#56636a]'
        }`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 1.2, ease: 'easeOut' } }}
        exit={leave}
      >
        {cue.text}
      </motion.p>
    );
  }

  const words = cue.text.split(' ');
  // Reveal across the first ~70% of the cue, so the line is whole and readable
  // for the rest of the time she is saying it.
  const step = Math.min(0.22, (cue.ms / 1000) * 0.7 / Math.max(1, words.length));
  // Let the previous line lift clear before this one starts writing itself in.
  const lead = reduced ? 0 : 0.32;

  return (
    <motion.p className={`${frame} max-w-[min(40ch,92vw)] ${SPEECH_TYPE}`} exit={leave}>
      {words.map((word, i) => (
        <motion.span
          key={i}
          className="inline-block whitespace-pre"
          initial={
            reduced
              ? { opacity: 0 }
              : {
                  opacity: 0,
                  y: 14,
                  filter: 'blur(10px)',
                  color: '#9dffbd',
                  textShadow: '0 0 24px rgba(40,220,100,1)',
                }
          }
          animate={
            reduced
              ? { opacity: 1 }
              : {
                  opacity: 1,
                  y: 0,
                  filter: 'blur(0px)',
                  color: '#eef3f2',
                  textShadow: '0 0 0px rgba(40,220,100,0)',
                }
          }
          transition={{
            delay: lead + i * step,
            duration: reduced ? 0.3 : 0.6,
            ease: [0.2, 0.7, 0.2, 1],
            color: { delay: lead + i * step + 0.2, duration: 1.1, ease: 'easeOut' },
            textShadow: { delay: lead + i * step + 0.2, duration: 1.6, ease: 'easeOut' },
          }}
        >
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </motion.p>
  );
}
