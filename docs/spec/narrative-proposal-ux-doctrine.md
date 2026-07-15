# Narrative Proposal: UX Doctrine

Input for Claude Design and Lovable. Every surface spec inherits these rules. When a surface spec conflicts with this doctrine, the doctrine wins; flag the conflict rather than resolving it silently.

## Who this is for

The MVP user is an AE or sales team member with no product training, on a deadline, building a proactive proposal. They should never wonder what to do next, where to click, or where to go. Design for the untrained, time-pressed user first; power-user affordances come later.

## Navigation: linear stepper

The pursuit moves through named stages: Intake → Outline → Themes → Draft → Review → Export. The stepper is always visible, shows the current stage, and marks completed stages. Earlier stages remain reachable for review; later stages are visibly locked until their gate clears.

## One primary action per screen

Every screen has exactly one visually primary action, and it advances the pursuit. Secondary actions exist but sit behind progressive disclosure (menus, hover, expansion), never as competing buttons. If a screen seems to need two primary actions, the screen is doing two jobs and should be split.

## Surfaces render from graph state, never from assumed sequence

No screen assumes an earlier step ran. Every surface reads the proposal graph and renders what it finds: an empty state, a blocked state with the reason and a link to the gate, or the working state. This is the rule that lets navigation loosen later (free movement for proposal managers in the federal fast-follow) without rewriting screens.

## Blocked and empty states are designed, not incidental

Every surface spec names its empty state and its blocked state. A blocked state always says why and where to go: "Drafting opens when themes are locked. Lock themes →". Never a disabled button without an explanation.

## Trust surfaces are first-class

Citations, source chips, "not found" states, gap markers, and unsupported-claim flags are the product's differentiation and must read as designed features, never as error styling. "Not found in source" is a calm, informative chip (the answer-flow Step 2 pattern), never a red alarm. The export warning for unsupported claims is loud but specific: it lists each claim and links to it.

## Consistency with the Q&A product

This is a sister application to Responsive's Q&A answering product. Reuse its visual language: spacing, type scale, chip and card patterns, the purple AI-treatment convention, the 2-second settle animation on applied changes. A user moving between the two products should feel one product family.

## Clutter budget

Every element on screen must earn its place for the untrained user's current task. Metadata, settings, and history are one click away, never ambient. When in doubt, remove it; the answer-flow principle applies: make the right action obvious at each state rather than surfacing all possibilities.

## AI actions follow the established grammar

AI never applies changes silently. It proposes; the human accepts, edits, or dismisses. Preview before apply. Applied changes settle visibly (purple border, 2s, then fade). Drafts are insertions the user commits, matching the answer-flow AIDraftStrip pattern.

## Language

Labels are verbs the user would say: "Lock themes", "Draft this section", "Fix flagged claims". No internal vocabulary on screen (no "pursuit graph", "entailment", "OutlineNode"). Stage names are plain words.
