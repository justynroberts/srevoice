import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import type { Turn } from '../hooks/useSreConversation';
import { SpokenText } from './RichText';

const ROLE_STYLES: Record<Turn['role'], { wrap: string; label: string; body: string }> = {
  user: {
    wrap: 'items-end',
    label: 'text-ink-faint',
    body: 'bg-raised text-ink rounded-2xl rounded-br-md',
  },
  agent: {
    wrap: 'items-start',
    label: 'text-accent',
    body: 'bg-surface border border-line text-ink rounded-2xl rounded-bl-md',
  },
  system: {
    wrap: 'items-center',
    label: 'text-ink-faint',
    body: 'bg-transparent text-ink-faint text-[11px] italic',
  },
};

export function Transcript({ turns, agentName }: { turns: Turn[]; agentName: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Only autoscroll while the reader is at the bottom — yanking them back down
  // mid-scroll is the fastest way to make a live log unusable.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Same instant behaviour as the observer below, so the two can never be
  // animating the same scrollTop against each other. Kept as a fallback for
  // browsers without ResizeObserver, where it is the only thing scrolling.
  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  // A turn keeps growing after it first renders — speech arrives in fragments
  // and the layout animation settles a frame later — so scrolling once when
  // `turns` changes lands short of the bottom on anything long. Following the
  // height keeps the newest words on screen as they appear.
  //
  // Deliberately instant rather than smooth, and the only thing that scrolls:
  // a smooth scroll that is restarted by every resize tick never arrives, and
  // two effects animating the same scrollTop is what jitter is made of. While
  // text streams in, snapping to the bottom each frame reads as the text
  // growing in place, which is the smoother illusion.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    // The container renders even when empty so the scroll listener and resize
    // observer above attach on first mount rather than never.
    <div ref={containerRef} className="mask-fade-top h-full overflow-y-auto px-4 py-4">
      {turns.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] text-ink-dim">Say hello to {agentName}.</p>
          <p className="max-w-xs text-[12px] leading-relaxed text-ink-faint">
            Start the session and ask something like “what’s triggered right now?” or “who’s on call
            for checkout?”
          </p>
        </div>
      )}
      <div ref={contentRef} className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {turns.map((turn) => {
            const style = ROLE_STYLES[turn.role];
            return (
              <motion.div
                key={turn.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                className={`flex flex-col gap-1 ${style.wrap}`}
              >
                {turn.role !== 'system' && (
                  <span
                    className={`px-1 font-mono-tight text-[10px] uppercase tracking-wider ${style.label}`}
                  >
                    {turn.role === 'user' ? 'You' : agentName}
                  </span>
                )}
                <div className={`max-w-[85%] px-3.5 py-2 text-[13px] leading-relaxed ${style.body}`}>
                  <SpokenText text={turn.text} />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div ref={endRef} />
      </div>
    </div>
  );
}
