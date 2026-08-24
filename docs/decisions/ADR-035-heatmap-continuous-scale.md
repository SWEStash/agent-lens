# ADR-035 — The heatmap encodes value as a continuous gradient, and drops the minimum-visible floor

- Status: Accepted
- Date: 2026-08-24
- Deciders: project owner
- Extends [ADR-034](ADR-034-heatmap-metric.md) (which settled *what* the cell counts; this settles how
  that value becomes a colour). **Reverses the "keep the 2:1 floor on the lowest step" ruling** taken
  during the ramp work — that ruling is recorded only in the local design notes, and this ADR is where
  a reader will look for why the floor is gone.

## Context

The tile binned its values into seven validated colour steps. Reading it raised the same complaint
three times: an empty cell and the lowest occupied cell differ far more than any other neighbouring
pair.

Measured, that is exactly right. Against ~0.065 lightness between every other adjacent pair:

| pair | dark ΔL | dark Δchroma | light ΔL |
|---|---|---|---|
| **empty → lowest step** | **0.179** | **0.070** | **0.204** |
| every other pair | ~0.065 | ~0.005 | ~0.065 |

Two attempts to fix it by re-picking colours — seven steps instead of five, then a near-neutral first
step — each helped and neither resolved it, because the cause is structural rather than chromatic:

**Under binning, every non-zero cell takes the lowest step's full colour however small the value.**
So empty→lowest is necessarily the largest jump on the scale, and it is a jump the data does not
contain. On the real corpus an hour worked once in three months (0.07 of a 5.0 peak) rendered louder
than the step from a busy hour to a busier one.

Compounding it, the `sqrt` transform was inherited from when the metric was work tokens. Tokens run
276× from the smallest active cell to the peak and genuinely need compression. Turns run **3.5× over
the median**, and compressing that spread put the same 1.4%-of-peak cell **11.8%** of the way up the
ramp before binning even applied.

## Decision

**1. Cells interpolate along the ramp rather than snapping to a step.** `rampColor` mixes between the
`--burn-*` stops; a value 1% of the way up the scale renders 1% of the way up. Distinct cell colours
on the real corpus went from 8 to 71 (turns) / 104 (tokens).

**2. The gradient starts at the empty cell's own colour** (`--panel2`, prepended to the stops), so the
scale runs continuously out of "no work" instead of beginning at a colour that must be visible.

**3. The transform follows the metric** (`rampPosition`): `sqrt` for tokens, `linear` for turns. The
transform is a property of the distribution, not of the chart.

**4. The legend is a gradient bar with value ticks beneath it.** Tick *positions* are even and the
*values* bend with the transform, so a reader lays a cell's colour against the strip and reads a
number off it.

**5. `--burn-*` are gradient anchors, not a palette.** Two of their properties still govern and are
recorded in `styles.css`: the first anchor is near-neutral, so the run out of a grey empty cell is a
change in lightness only rather than a jump from neutral into colour; and each anchor's chroma is the
most the sRGB gamut holds at its lightness, because asking for more clips and clipping drags
lightness toward the neighbouring anchor.

## What this gives up

**A cell with any work no longer clears 2:1 against an empty cell.** That floor was previously treated
as an accessibility requirement rather than an aesthetic choice, and it was held through two rounds of
re-colouring.

It was dropped because it is **incompatible with the complaint, not merely in tension with it**: a
value of 0.07 against a peak of 5.0 cannot simultaneously look proportionally tiny and be clearly
visible. Four candidate ramps were rendered against the real corpus; every one that softened the jump
enough to satisfy the reading also fell below the floor. The choice is which of the two properties the
chart keeps, and the owner chose proportionality after seeing them side by side.

The mitigations are that the value is never carried by colour alone: every cell has a hover tooltip
with its exact figure, and the legend's ticks map colour to number without hovering.

This does not generalise. It is a judgement about a 168-cell overview grid whose job is showing where
the dense hours are; it is not licence to drop contrast floors on marks a reader must identify
individually.

## Consequences

- **Near-zero cells are close to invisible, deliberately.** That is the decision, not a defect. Anyone
  "fixing" it by restoring a minimum step colour reintroduces exactly the complaint this ADR answers.
- **The ordinal palette validator no longer governs the ramp end to end.** It checks discrete steps —
  monotone lightness, a ΔL floor between neighbours, a contrast floor on the extreme step. As gradient
  anchors, the ΔL floor between them is no longer a legibility constraint. The anchors still pass it,
  and keeping that true is a cheap way to keep the curve well-formed, but it is no longer the reason.
- **Two metrics now render the same cell very differently.** Sunday 07:00 is near-invisible under
  turns and mid-scale under tokens. Both are correct for what they count (ADR-034), and the guide says
  which is showing.
- **`rampStep` and `rampBounds` are gone**, replaced by `rampPosition` / `rampColor` / `rampTicks`.
