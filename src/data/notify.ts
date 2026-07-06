import { execFile } from 'child_process';
import * as os from 'os';

const noop = (): void => {};

/** Keep sound names to a safe charset — they interpolate into a file path / AppleScript. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '') || 'Ping';
}

/**
 * Play a short attention sound. Best-effort and non-blocking — never throws, and a
 * missing player / sound file just does nothing.
 * - macOS: `afplay` a bundled system sound.
 * - Windows: the system "Asterisk" sound via PowerShell (no file needed).
 * - Linux: `paplay` a freedesktop sound, falling back to `aplay`.
 */
export function playSound(soundName: string): void {
  const p = os.platform();
  try {
    if (p === 'darwin') {
      execFile('afplay', [`/System/Library/Sounds/${safeName(soundName)}.aiff`], noop);
    } else if (p === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()'], noop);
    } else {
      execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga'], (err) => {
        if (err) {
          execFile('aplay', ['-q', '/usr/share/sounds/alsa/Front_Center.wav'], noop);
        }
      });
    }
  } catch {
    /* ignore */
  }
}

function osaQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Show a native OS notification banner — visible even when VS Code is in the
 * background. When `soundName` is set, the banner also carries that sound (so we
 * don't double up with playSound). Best-effort; never throws.
 * - macOS: `osascript display notification` (banner + sound in one call).
 * - Linux: `notify-send` (+ playSound for audio).
 * - Windows: no dependency-free native toast, so it falls back to the system sound;
 *   the in-app VS Code toast carries the visual there.
 */
export function nativeNotify(title: string, message: string, soundName?: string): void {
  const p = os.platform();
  try {
    if (p === 'darwin') {
      let script = `display notification ${osaQuote(message)} with title ${osaQuote(title)}`;
      if (soundName) {
        script += ` sound name ${osaQuote(safeName(soundName))}`;
      }
      execFile('osascript', ['-e', script], noop);
    } else if (p === 'win32') {
      if (soundName) {
        playSound(soundName);
      }
    } else {
      execFile('notify-send', ['-a', 'Claude Code', title, message], noop);
      if (soundName) {
        playSound(soundName);
      }
    }
  } catch {
    /* ignore */
  }
}
