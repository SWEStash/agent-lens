/** Copies the absolute path of this session's archived .jsonl transcript, so another agent running
 * on this machine can be pointed straight at the file — no hunting for a session id under ~/.claude,
 * which may have rotated the transcript away long ago.
 *
 * The path comes from its own endpoint rather than the session payload because it is an absolute
 * host path and session payloads are published to the static snapshot (ADR-027) — which is also why
 * this renders nothing there. */
import CopyButton from "../CopyButton";
import { SNAPSHOT, type SessionLocation } from "../api";
import { useFetch } from "../useFetch";

export function ArchivePathButton({ id }: { id: string }) {
  // No live API in snapshot mode, and no snapshot key for this route by design. Split in two so the
  // fetch hook is never called conditionally.
  return SNAPSHOT ? null : <CopyArchivePath id={id} />;
}

function CopyArchivePath({ id }: { id: string }) {
  const { data: loc } = useFetch<SessionLocation>("/sessions/" + id + "/location", { reset: true });
  // A convenience affordance: while it loads, or when the session predates source_file bookkeeping
  // (404), the row simply doesn't carry the button — an error state here would be noise.
  if (!loc) return null;
  return (
    <CopyButton
      text={loc.path}
      className="copy-archive-path"
      label="Copy archive path"
      title="Copy archive path"
      tip={
        `Copies the path to this session's full raw trace, the archived .jsonl transcript with every ` +
        `event verbatim, so you can point another agent on this machine straight at it.\n\n` +
        loc.path +
        (loc.exists ? "" : "\n\n(that file is no longer on disk — retention has pruned it)")
      }
    />
  );
}
