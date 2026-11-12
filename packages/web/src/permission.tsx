/** How a tool call was approved (ADR-040): the labels the transcript tag and the Security view share. */
import type { FindingApproval, PermissionDecision, PermissionVia } from "./api";

const BY: Record<PermissionVia, string> = {
  user: "you",
  rule: "rule",
  mode: "permission mode",
  classifier: "classifier",
  hook: "hook",
  safety_check: "safety check",
  other: "settings",
};

const SCOPE: Record<string, string> = { once: "once", session: "for the session" };

/** The short label, its tooltip, and whether it is a rejection. Null when nothing was recorded. */
export function permissionLabel(p: PermissionDecision | null): { text: string; title: string; rejected: boolean } | null {
  if (!p) return null;
  const rejected = p.decision === "reject";
  const who = BY[p.via] ?? BY.other;
  let text = rejected ? `rejected by ${who}` : p.via === "user" ? `approved by ${who}` : `allowed by ${who}`;
  if (p.via === "user" && p.scope) text += `, ${SCOPE[p.scope] ?? p.scope}`;
  const facts = [p.rule_source && `rule source: ${p.rule_source}`, p.reason && `reason: ${p.reason}`].filter(Boolean);
  return { text, title: facts.length ? facts.join(" · ") : text, rejected };
}

/** The Security view's approval filter, in the order it lists them; values are the API's `approval=`. */
export const APPROVAL_OPTIONS: Array<{ value: FindingApproval; label: string }> = [
  { value: "rejected", label: "rejected" },
  { value: "user", label: "approved by you" },
  { value: "rule", label: "allowed by rule" },
  { value: "mode", label: "allowed by permission mode" },
  { value: "classifier", label: "allowed by classifier" },
  { value: "hook", label: "allowed by hook" },
  { value: "safety_check", label: "allowed by safety check" },
  { value: "other", label: "allowed by settings" },
  { value: "unknown", label: "not recorded" },
];

/** The tag a tool call or finding shows; nothing when unrecorded unless `unknown` asks for a label. */
export function PermissionTag({ p, unknown }: { p: PermissionDecision | null; unknown?: boolean }) {
  const l = permissionLabel(p);
  if (!l) return unknown ? <span className="tag perm perm-unknown" data-tip="This transcript did not record how the call was approved">not recorded</span> : null;
  return (
    <span className={"tag perm" + (l.rejected ? " perm-reject" : "")} data-tip={l.title}>
      {l.text}
    </span>
  );
}
