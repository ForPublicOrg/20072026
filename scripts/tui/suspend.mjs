// Cleanly hands the terminal back to a child process for the duration of
// `fn`, then returns so the caller can re-render Ink. Needed specifically
// for scripts/collect-batch.mjs, which prints its own live, long-running
// yt-dlp/ffmpeg progress — capturing and dumping that after the fact would
// be a poor experience for a multi-minute run. (wrangler login and R2
// transfers don't need this: login happens before Ink ever mounts, and R2
// transfers from the TUI use the `quiet` option instead — see
// scripts/lib/admin-resources.mjs.)
export function suspendInk(instance, fn) {
  instance.unmount();
  // Defensive: Ink's own cleanup on unmount() is usually enough, but a
  // spawnSync launched immediately after can race it — belt and suspenders.
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  try {
    fn();
  } finally {
    process.stdin.resume();
  }
}
