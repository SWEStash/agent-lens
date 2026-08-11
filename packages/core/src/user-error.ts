/**
 * `UserError` — an error caused by what the user typed or configured, as opposed to a bug.
 *
 * The CLI's top-level boundary (packages/cli/src/index.ts) prints these as a single
 * `agent-lens: <message>` line and exits 1, and lets everything else through with its stack intact.
 * That split is the whole point: a bad `--times` value is not a crash and shouldn't read like one,
 * while a genuine TypeError is worthless without the trace.
 *
 * So throw this only where the message is already written *for the user* — it becomes the entire
 * output they see, with no stack to fall back on.
 *
 * (Unrelated to `errors.ts`, which classifies the tool-call errors found inside collected
 * transcripts. This one is about the CLI process itself.)
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
