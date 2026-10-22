import { useCallback, useEffect, useRef, useState } from 'react';
import { getMicDeviceId, openMic, setMicDeviceId } from '../lib/mic';
import { Button, Callout, Select } from './ui';

/** Below this RMS level for the whole window, the device is treated as silent. */
const SILENCE_RMS = 0.004;
const SILENCE_WINDOW_MS = 4000;

/**
 * Pick the microphone Paige hears, and prove it works before a session does.
 *
 * The meter listens only while it is open, and releases the device on close —
 * a settings panel that left the recording indicator on would read as spying.
 */
export function MicCheck() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState(getMicDeviceId);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopRef = useRef<() => void>(() => undefined);

  const listDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default'));
    } catch {
      setDevices([]);
    }
  }, []);

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => undefined;
    setTesting(false);
    setLevel(0);
  }, []);

  const test = useCallback(
    async (deviceId: string) => {
      stop();
      setError(null);
      setSilent(false);
      try {
        const { stream } = await openMic(deviceId);
        // Labels are only exposed once a microphone has been granted.
        void listDevices();

        const audio = new AudioContext();
        // Created outside a fresh gesture it starts suspended and reads all
        // zeros — which would falsely report a dead microphone.
        await audio.resume().catch(() => undefined);
        const source = audio.createMediaStreamSource(stream);
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);

        let frame = 0;
        let peak = 0;
        let shown = 0;
        const started = performance.now();
        const tick = () => {
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (const v of buffer) sum += v * v;
          const rms = Math.sqrt(sum / buffer.length);
          peak = Math.max(peak, rms);
          // Fast attack, slow release, so speech reads as a level, not a flicker.
          shown = Math.max(Math.min(1, rms * 8), shown * 0.9);
          setLevel(shown);
          if (performance.now() - started > SILENCE_WINDOW_MS) setSilent(peak < SILENCE_RMS);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        setTesting(true);

        stopRef.current = () => {
          cancelAnimationFrame(frame);
          stream.getTracks().forEach((t) => t.stop());
          void audio.close();
        };
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Chrome is blocking the microphone for this site. Allow it from the icon at the left of the address bar, then try again.'
            : `Could not open that microphone: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [listDevices, stop],
  );

  useEffect(() => {
    void listDevices();
    const onChange = () => void listDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
      stopRef.current();
    };
  }, [listDevices]);

  const choose = (deviceId: string) => {
    setSelected(deviceId);
    setMicDeviceId(deviceId);
    if (testing) void test(deviceId);
  };

  const pinnedMissing = selected && devices.length > 0 && !devices.some((d) => d.deviceId === selected);

  return (
    <section className="space-y-3">
      <Select
        label="Microphone"
        value={selected}
        onChange={(e) => choose((e.target as HTMLSelectElement).value)}
        options={[
          { value: '', label: 'System default' },
          ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
        ]}
        hint="Remembered in this browser. Pick one explicitly if plugging in a screen or dock keeps moving your default."
      />

      <div className="flex items-center gap-3">
        <Button tone="ghost" onClick={() => (testing ? stop() : void test(selected))} className="shrink-0">
          {testing ? 'Stop test' : 'Test microphone'}
        </Button>
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-raised"
          role="meter"
          aria-label="Microphone input level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${silent ? 'bg-warn' : 'bg-accent'}`}
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      </div>

      {testing && !silent && <p className="text-[12px] text-ink-faint">Talk normally — the bar should move.</p>}
      {silent && (
        <Callout tone="warn">
          This microphone is sending silence. Pick another device above, or check macOS System Settings → Sound →
          Input.
        </Callout>
      )}
      {pinnedMissing && (
        <Callout tone="warn">The chosen microphone is not connected — sessions will use the system default.</Callout>
      )}
      {error && <Callout tone="error">{error}</Callout>}
    </section>
  );
}
