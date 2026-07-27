/**
 * Workflow fan-out: the session-detail run grouping and the /api/workflows/:run_id detail page.
 *
 * Each Workflow tool_call carries a run id + name and sits on a turn; the spawned agents attribute to
 * it via sessions.workflow_run_id, so the UI can show "🔀 <name> · N agents · turn X" instead of one
 * flat, unattributed list. The detail endpoint resolves the launching call (name, parent crumb) plus
 * those agents, with roll-up stats — preferring the ingested result sidecar over the transcript
 * notification when both exist.
 */
import { describe, it, expect } from "vitest";
import { addEvent, addSession, addTool, addTurn, appFor, freshDb } from "./helpers/seed";

/** An orchestrator session whose turn 0 launches run `wf_run1` via a Workflow tool call. */
function seedOrchestrator(opts: { title?: string | null; status?: string; resultSummary?: string; inputJson?: string } = {}) {
  const db = freshDb();
  addSession(db, "orch", { title: opts.title ?? null, events: 2, turns: 1 });
  const turn = addTurn(db, "orch", 0, { userEvent: "oe1", preview: "run it", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", durationMs: 60000 });
  addEvent(db, "orch", "oe1", { turn, seq: 0, role: "user", timestamp: "2026-01-01T00:00:00Z", text: "run it" });
  addEvent(db, "orch", "oe2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:00:30Z" });
  addTool(db, "orch", "oe2", "tu_wf", "Workflow", {
    turn,
    workflowRun: "wf_run1",
    workflowName: "my-flow",
    status: opts.status,
    result: opts.resultSummary,
    inputRaw: opts.inputJson,
  });
  return { db, turn };
}

describe("session detail exposes workflow run grouping", () => {
  it("GET /api/sessions/:id → workflow_runs + children carry workflow_run_id", async () => {
    const { db, turn } = seedOrchestrator();
    for (const id of ["agent-x", "agent-y"]) addSession(db, id, { sidechain: true, workflowRun: "wf_run1", parent: "orch", parentTurn: turn });
    const app = await appFor(db);

    const body = (await app.inject({ method: "GET", url: "/api/sessions/orch" })).json();
    expect(body.workflow_runs).toHaveLength(1);
    expect(body.workflow_runs[0]).toMatchObject({ run_id: "wf_run1", name: "my-flow", turn_seq: 0, agent_count: 2 });
    expect(body.children).toHaveLength(2);
    expect(body.children.every((c: { workflow_run_id: string }) => c.workflow_run_id === "wf_run1")).toBe(true);
    // The launching Workflow tool_call exposes its run so the transcript can render the fan-out block.
    const wfTool = body.events
      .flatMap((e: { toolCalls: Array<{ tool_name: string }> }) => e.toolCalls)
      .find((t: { tool_name: string }) => t.tool_name === "Workflow");
    expect(wfTool).toMatchObject({ workflow_name: "my-flow", workflow_agent_count: 2 });
    await app.close();
  });
});

describe("workflow detail endpoint", () => {
  /** The orchestrator above, plus two agents and a completion <task-notification> in the transcript. */
  async function appWithRun() {
    const { db, turn } = seedOrchestrator({
      title: "Orchestrator",
      status: "async_launched",
      resultSummary: "all done",
      inputJson: '{"description":"do the thing","args":"[{\\"skill\\":\\"a\\"}]"}',
    });
    const notification =
      "<task-notification><tool-use-id>tu_wf</tool-use-id><status>completed</status><summary>flow done</summary>" +
      '<result>{"ok":true}</result><failures>none</failures></task-notification>';
    addEvent(db, "orch", "oe3", { turn, seq: 2, role: "user", timestamp: "2026-01-01T00:02:00Z", text: notification });
    addSession(db, "agent-x", { title: "Agent X", sidechain: true, workflowRun: "wf_run1", parent: "orch", parentTurn: turn, startedAt: "2026-01-01T00:00:40Z", endedAt: "2026-01-01T00:00:50Z" });
    addSession(db, "agent-y", { title: "Agent Y", sidechain: true, workflowRun: "wf_run1", parent: "orch", parentTurn: turn, startedAt: "2026-01-01T00:00:45Z", endedAt: "2026-01-01T00:01:10Z" });
    return appFor(db);
  }

  it("GET /api/workflows/:run_id → name, parent crumb, agents + stats", async () => {
    const app = await appWithRun();
    const r = await app.inject({ method: "GET", url: "/api/workflows/wf_run1" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ run_id: "wf_run1", name: "my-flow", status: "async_launched", result_summary: "all done" });
    // The launch payload is exposed so the page can render it (LaunchView) for async runs.
    expect(body.input_json).toContain('"description":"do the thing"');
    expect(body.parent).toMatchObject({ id: "orch", title: "Orchestrator", turn_seq: 0 });
    expect(body.agents.map((a: { id: string }) => a.id).sort()).toEqual(["agent-x", "agent-y"]);
    expect(body.stats.agent_count).toBe(2);
    // The run's wall-clock span is earliest agent start → latest agent end, NOT the sum of the agents'
    // own durations: they overlap. Here 00:00:40 → 00:01:10.
    expect(body.stats.duration_ms).toBe(30_000);
    // The completion comes from the <task-notification>, not the launch ack (result_summary).
    expect(body.completion).toMatchObject({ status: "completed", summary: "flow done", result: '{"ok":true}', failures: "none" });
    await app.close();
  });

  it("GET /api/workflows/:run_id → 404 for unknown run", async () => {
    const app = await appWithRun();
    const r = await app.inject({ method: "GET", url: "/api/workflows/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("prefers the result sidecar (workflow_results) over the transcript notification", async () => {
    // A launched-but-unacknowledged run in the transcript, plus the ingested sidecar for the same run:
    // the sidecar must supply status + completion + the run roll-up.
    const db = freshDb();
    addSession(db, "orch", { title: "Orchestrator" });
    const turn = addTurn(db, "orch", 0, { userEvent: "oe1" });
    addEvent(db, "orch", "oe2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:00:30Z" });
    addTool(db, "orch", "oe2", "tu_wf", "Workflow", { turn, workflowRun: "wf_side", workflowName: "my-flow", status: "async_launched" });
    db.prepare(
      `INSERT INTO workflow_results (run_id, source_id, session_id, task_id, workflow_name, status, summary, default_model,
                                     result_json, phases_json, logs_json, agent_count, total_tokens, total_tool_calls,
                                     duration_ms, started_at, ended_at, ingested_at)
       VALUES ('wf_side', 'test', 'orch', 'tk1', 'my-flow', 'completed', 'evals done', 'claude-fable-5',
               '{"total":{"green":5}}', '[{"title":"Generate"},{"title":"Judge"}]', '["a: GREEN 5/5"]',
               12, 500, 24, 5000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z', 'now')`,
    ).run();
    const app = await appFor(db);

    const body = (await app.inject({ method: "GET", url: "/api/workflows/wf_side" })).json();
    expect(body.status).toBe("completed"); // sidecar status, not the tool_call's async_launched
    expect(body.completion).toMatchObject({ status: "completed", summary: "evals done", result: '{"total":{"green":5}}' });
    expect(body.run).toMatchObject({ default_model: "claude-fable-5", agent_count: 12, total_tool_calls: 24, duration_ms: 5000 });
    expect(body.run.phases.map((p: { title: string }) => p.title)).toEqual(["Generate", "Judge"]);
    expect(body.run.logs).toEqual(["a: GREEN 5/5"]);
    await app.close();
  });

  it("serves the workflowProgress timeline as run.progress (backs the phase graph)", async () => {
    const progress = JSON.stringify([
      { type: "workflow_phase", index: 1, title: "Generate" },
      { type: "workflow_agent", phaseIndex: 1, phaseTitle: "Generate", agentId: "a1", model: "claude-fable-5", state: "done" },
      { type: "workflow_phase", index: 2, title: "Judge" },
      { type: "workflow_agent", phaseIndex: 2, phaseTitle: "Judge", agentId: "a2", model: "claude-opus-4-8", state: "done" },
    ]);
    const db = freshDb();
    addSession(db, "orch");
    const turn = addTurn(db, "orch", 0, { userEvent: "oe1" });
    addEvent(db, "orch", "oe2", { turn, seq: 1, role: "assistant", timestamp: "2026-01-01T00:00:30Z" });
    addTool(db, "orch", "oe2", "tu_wf", "Workflow", { turn, workflowRun: "wf_prog", workflowName: "my-flow", status: "async_launched" });
    db.prepare(
      `INSERT INTO workflow_results (run_id, source_id, session_id, workflow_name, status, progress_json, ingested_at)
       VALUES ('wf_prog', 'test', 'orch', 'my-flow', 'completed', ?, 'now')`,
    ).run(progress);
    const app = await appFor(db);

    const body = (await app.inject({ method: "GET", url: "/api/workflows/wf_prog" })).json();
    expect(Array.isArray(body.run.progress)).toBe(true);
    expect(body.run.progress).toHaveLength(4);
    expect(
      body.run.progress.filter((e: { type: string }) => e.type === "workflow_agent").map((e: { model: string }) => e.model),
    ).toEqual(["claude-fable-5", "claude-opus-4-8"]);
    await app.close();
  });

  it("GET /api/workflows/:run_id → agents carry session_meta fields", async () => {
    const { db, turn } = seedOrchestrator({ title: "Orch", status: "async_launched" });
    addSession(db, "agent-x", { sidechain: true, workflowRun: "wf_run1", startedAt: "2026-01-01T00:00:40Z" });
    db.prepare(
      `INSERT INTO session_meta (session_id, source_id, agent_type, agent_description, spawn_depth, tool_use_id, ingested_at)
       VALUES ('agent-x', 'test', 'ai-evaluation', 'gen-red for ai-evaluation', NULL, 'toolu_2', 'now')`,
    ).run();
    const app = await appFor(db);

    const body = (await app.inject({ method: "GET", url: "/api/workflows/wf_run1" })).json();
    expect(body.agents[0]).toMatchObject({ id: "agent-x", agent_type: "ai-evaluation", agent_description: "gen-red for ai-evaluation" });
    await app.close();
  });
});
