/**
 * Which microphone to talk through, remembered per browser.
 *
 * Plugging in a monitor, dock or headset can quietly move the system's default
 * input to a device with no working microphone. Chrome then captures silence
 * and ElevenLabs transcribes every turn as "...", which looks exactly like a
 * broken app. Pinning a device here takes the system default out of the loop.
 *
 * An empty string means "follow the system default".
 */
const KEY = 'srevoice.micDeviceId';

export function getMicDeviceId(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setMicDeviceId(id: string): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the choice lasts for this page only, which is still useful.
  }
}

/**
 * Opens the chosen microphone, falling back to the default when that device
 * has since been unplugged — an absent dock should not block the session.
 */
export async function openMic(deviceId: string = getMicDeviceId()): Promise<{ stream: MediaStream; deviceId: string }> {
  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      return { stream, deviceId };
    } catch (err) {
      // Permission refusals are real failures; a missing device is not.
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return { stream, deviceId: '' };
}
