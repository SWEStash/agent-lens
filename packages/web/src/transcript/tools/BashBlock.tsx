import type { ToolCall } from "../../api";
import CopyButton from "../../CopyButton";
import { ToolShell } from "./ToolShell";
import { splitShellCommand } from "../shell";
import type { BashInput } from "../parse";

/** Render a Bash tool call as a shell console: the description as a `#` caption beside the title (or, if
 * absent, a one-line command preview when collapsed), and when open a terminal-style command block with
 * a `$` prompt per logical command (heredoc bodies / continuations get no prompt), flag badges, the
 * command output, and the raw input JSON one click away. Mirrors ToolChip's collapsible container +
 * result rendering so hide-tools/collapse behaviour is unchanged. */
export function BashBlock({ t, bash }: { t: ToolCall; bash: BashInput }) {
  const preview = bash.command.split("\n")[0];
  const lines = splitShellCommand(bash.command);
  return (
    <ToolShell
      t={t}
      name="🖥 Bash"
      head={(open) =>
        bash.description ? <span className="bash-desc"># {bash.description}</span> : !open && <span className="bash-preview">{preview}</span>
      }
      result="shell"
      rawJson
    >
      <div className="shell code-block">
        <CopyButton text={bash.command} className="copy-corner" title="Copy command" />
        <pre className="shell-cmd">
          {lines.map((l, i) => (
            <span key={i}>
              <span className={"shell-gutter" + (l.cont ? " cont" : "")} aria-hidden="true">
                {l.cont ? "  " : "$ "}
              </span>
              {l.text}
              {i < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </pre>
      </div>
      {(bash.run_in_background || bash.restart || bash.timeout != null) && (
        <div className="bash-badges">
          {bash.run_in_background && <span className="bash-badge">background</span>}
          {bash.restart && <span className="bash-badge">restart</span>}
          {bash.timeout != null && <span className="bash-badge">timeout {Math.round(bash.timeout / 1000)}s</span>}
        </div>
      )}
    </ToolShell>
  );
}
