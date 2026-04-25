import type { ThreadDoneNotificationSound } from "contracts/settings";

export type NotificationSoundOption = {
  value: ThreadDoneNotificationSound;
  label: string;
};

export const THREAD_DONE_NOTIFICATION_SOUND_OPTIONS: readonly NotificationSoundOption[] = [
  { value: "chime", label: "Chime" },
  { value: "bell", label: "Bell" },
  { value: "pop", label: "Pop" },
  { value: "sweep", label: "Sweep" },
] as const;

type AudioContextConstructor = typeof AudioContext;

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextClass: AudioContextConstructor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;

  if (!AudioContextClass) return null;
  sharedAudioContext ??= new AudioContextClass();
  return sharedAudioContext;
}

function note(
  audioContext: AudioContext,
  destination: AudioNode,
  input: {
    frequency: number;
    start: number;
    duration: number;
    type?: OscillatorType;
    gain?: number;
    endFrequency?: number;
  },
) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const startAt = audioContext.currentTime + input.start;
  const endAt = startAt + input.duration;

  oscillator.type = input.type ?? "sine";
  oscillator.frequency.setValueAtTime(input.frequency, startAt);
  if (input.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(input.endFrequency, endAt);
  }

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(input.gain ?? 0.08, startAt + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.02);
}

export function playThreadDoneNotificationSound(sound: ThreadDoneNotificationSound): void {
  const audioContext = getAudioContext();
  if (!audioContext) return;

  void audioContext
    .resume()
    .then(() => {
      const output = audioContext.createGain();
      output.gain.value = 0.72;
      output.connect(audioContext.destination);

      switch (sound) {
        case "bell":
          note(audioContext, output, { frequency: 880, start: 0, duration: 0.18, gain: 0.07 });
          note(audioContext, output, {
            frequency: 1320,
            start: 0.04,
            duration: 0.28,
            gain: 0.04,
          });
          break;
        case "pop":
          note(audioContext, output, {
            frequency: 220,
            endFrequency: 520,
            start: 0,
            duration: 0.09,
            type: "triangle",
            gain: 0.1,
          });
          break;
        case "sweep":
          note(audioContext, output, {
            frequency: 392,
            endFrequency: 784,
            start: 0,
            duration: 0.22,
            type: "sine",
            gain: 0.075,
          });
          note(audioContext, output, {
            frequency: 988,
            start: 0.13,
            duration: 0.16,
            gain: 0.045,
          });
          break;
        case "chime":
          note(audioContext, output, {
            frequency: 659.25,
            start: 0,
            duration: 0.16,
            gain: 0.065,
          });
          note(audioContext, output, {
            frequency: 987.77,
            start: 0.09,
            duration: 0.2,
            gain: 0.055,
          });
          break;
      }

      window.setTimeout(() => {
        output.disconnect();
      }, 700);
    })
    .catch(() => {});
}
