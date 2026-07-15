# Narrative Proposal: Visual Pattern Inventory

Extracted from seven screenshots of the Q&A product (answer-flow-design). Bundle with the UX doctrine for every Claude Design handoff. These are the patterns the new product reuses; deviations need a stated reason.

## Creation flow (stepper)

- Three-step horizontal progress bars at top, green fill for completed, label "STEP n OF n" beneath.
- One large centered task per step: drop zone (step 1), review layout (step 2), assignment list (step 3).
- Primary action bottom-right as a gradient button ("Continue →"); secondary ("Back") plain text bottom-left.
- Upload drop zone: dashed border card, gradient icon, "Drop your file here or click to browse", accepted formats and size limit in muted text.

## Trust surfaces (step 2 review)

- "AI-detected" badge: purple sparkle chip above the title.
- "Not found in RFP": muted amber/tan pill next to the field label; input below stays empty and editable. Calm, never red.
- Source chips: compact pill with ↗ arrow, section name, and cell/anchor ref ("99. Scoring Summary · A29"). Sits right-aligned next to the claim it supports.
- Key requirements: bulleted list, each bullet paired with its source chip.
- Two-column layout: extracted narrative content left, editable project details right.

## AI assignment pattern (step 3)

- Per-row purple "AI" sparkle chip marking AI-proposed values, dropdown to override, avatar confirming the person.
- Toolbar: "Re-suggest with AI" (purple, sparkle) and "Clear all"; right-aligned tally "AI matched 17 of 17".
- Copy pattern: AI proposes, human adjusts, adjustable later ("Adjust anything — you can also reassign individual questions later").

## Workspace shell

- Left rail: numbered section list with per-section progress (0/22), owner avatars, "YOU" chip on sections assigned to the viewer, expandable question list, search box, overall completion ring top-left.
- Top bar: breadcrumb (project › section), collaborator avatars, kebab menu, view toggle (cards/table), primary gradient action top-right ("Run AI draft").
- Filter chips row: Flagged, Open Comments, Unanswered (with count), AI Drafts, More Filters.

## Welcome-back modal

- Summary card of the file and counts, "AI-generated summary" purple chip with provenance ("from SRM_RFP_Evaluation.xlsx").
- "Assigned to you" block: big number, section chips with per-section counts.
- One primary gradient action ("Continue to AI Draft →"), one plain-text escape ("I'll answer manually").

## Question cards and table

- Card: ID chip (0I-03), question text, right-side icon row (comment, attach, flag, sparkle). Sparkle in purple when an AI draft is ready.
- Table view: checkbox, ID, question, answer preview with "Show more", status ("Not Started" with ring icon), source column, actions.
- Status vocabulary: Not Started → In Progress → Answered → Complete, shown as ring/filled icons and text.

## Color and type

- Neutral light UI, near-black text, generous whitespace, rounded cards with soft borders.
- Purple reserved exclusively for AI (chips, sparkles, draft-ready states).
- Green for progress and completion.
- Gradient (green→blue or purple→pink) only on the single primary CTA per screen.
- Amber/tan muted pills for "not found" and caution states.

## Mapping to the new product

- Intake screen inherits the creation-flow stepper, drop zone, and step-2 review pattern wholesale (extracted context + source chips + not-found pills).
- Drafting canvas inherits the workspace shell, purple-AI grammar, and card icon row.
- Theme workspace inherits the step-3 pattern: AI proposes rows, human edits, one confirming action (lock).
- Review view inherits filter chips and the table view.
- Export inherits the modal pattern: summary card, loud-but-specific warning list, one primary action.
