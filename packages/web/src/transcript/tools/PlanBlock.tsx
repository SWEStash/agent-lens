import { CollapsibleText } from "../Message";

/** Render an approved plan as its own titled, collapsible card (markdown), instead of a raw JSON tool
 * chip or an opaque "Plan approved" line. */
export function PlanBlock({ plan }: { plan: string }) {
  return (
    <div className="plan-card">
      <div className="plan-card-head">📋 Approved plan</div>
      <CollapsibleText text={plan} />
    </div>
  );
}
