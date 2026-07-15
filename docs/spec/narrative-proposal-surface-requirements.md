# Narrative Proposal: Surface Requirements

Fourth artifact in the spec sequence. Six MVP surfaces, all ratified. Every surface inherits the UX doctrine (linear stepper, one primary action, surfaces render from graph state, designed empty/blocked states) and the visual pattern inventory. Conflicts with the doctrine get flagged, not silently resolved.

## 1. Intake screen

Purpose: AE starts a pursuit, uploads sources, reviews what the Intake agent extracted.

1. Create pursuit: name, account (CRM picker), kind. Defaults to `proactive_proposal`.
2. Upload transcript, CRM extract, or notes; multiple sources per pursuit; parse status visible per source. Accepted formats at MVP: .txt, .docx, .csv, and pasted text. PDF is deferred (ratified): the upload zone does not offer it, and a PDF that arrives anyway fails loudly with a reason, never silently.
3. Extracted context renders as fields (customer, problem, scope, budget signals, stakeholders, competitive mentions), each with a source chip linking to its locator. Same pattern as answer-flow Step 2.
4. Unfound fields show a "not found" state with an empty editable input, never a guess.
5. Human edits to any extracted field are marked human-entered and carry no source chip.
6. Continue to outline is blocked until parsing completes.

Primary action: Continue to outline.

## 2. Outline view

Purpose: AE reviews the AI-generated outline, adjusts structure, moves to themes.

1. Tree renders from the graph: numbered nodes, titles, purpose annotations, matching the Q&A left-rail section pattern.
2. Each node shows an "AI" chip (step-3 assignment pattern); human edits to a node clear the chip.
3. Add, rename, reorder (drag), delete. Delete warns if the node has content or claims.
4. "Re-suggest with AI" regenerates untouched nodes only; human-edited nodes are never overwritten (Outline agent contract).
5. Empty state (no intake context): blocked with "Outline opens when intake completes" and a link back.

Primary action: Continue to themes.

## 3. Theme workspace

Purpose: AE reviews AI-drafted win themes and discriminators, edits, and locks. First hard gate.

1. Themes render as editable rows grouped by kind (theme, discriminator, ghost), each with the purple AI chip; editing clears the chip.
2. Add, edit, delete; "Re-suggest with AI" creates new drafts alongside, never replacing human-edited rows (Theme agent contract).
3. Each theme shows its scope: whole proposal or specific sections; section picker behind disclosure.
4. Locking is one action for the whole set (ratified: set-level, not per-theme). Confirmation states that locked themes shape every AI draft.
5. Unlock is free before any drafting has run; after drafting exists, unlock warns that redrafting is needed for changes to take effect.
6. Blocked state if intake produced no context: explains why and links back.

Primary action: Lock themes and start drafting.

## 4. Drafting canvas

Purpose: AE drafts section by section with AI, reviews claims and citations, fills gaps.

1. Layout: left rail is the outline tree with per-node status (Q&A workspace shell); center is the editor for the selected node.
2. "Draft this section" is the primary action on an empty node; "Draft all remaining (n)" appears as a quiet text link beneath it (ratified: visible but visually subordinate, not behind disclosure), with progress and cancel during the run (Bulk AI Draft pattern).
3. AI drafts arrive as proposals the user inserts (AIDraftStrip grammar); inserted content settles with the purple-border treatment.
4. Claims render as subtly marked spans; clicking one opens its citation (source chip pattern: asset name, locator, quote). Marks visible on hover and via a "show claims" toggle, not ambient underlines.
5. Gap markers ("[no supporting evidence found in library]") render as amber chips inline with one action: "Find evidence" opens retrieval to search the library and attach a passage; or the user rewrites the sentence.
6. Verification status per claim: verified (quiet), unsupported (amber flag), stale (neutral "re-check" chip, one-click re-verify).
7. Inline AI actions on selected text: tighten, expand, tailor. Each proposes a replacement with preview before apply.
8. Editing inside a claim span flips it to stale immediately and visibly.
9. Node status (empty → drafting → in review → final) is set by the user via one control, not inferred.

Primary action (once all nodes have content): Continue to review.

## 5. Review view

Purpose: AE runs the evaluator, works through findings, resolves comments.

1. "Run evaluation" is the primary action on entry; it snapshots the pursuit and produces the report. Progress with cancel during the run.
2. Findings render grouped by kind (unsupported claims, repetition, theme gaps, coherence), each with severity, an excerpt, and one action: "Go to fix," opening the drafting canvas at the anchored node or claim.
3. Filter chips by finding kind (Q&A filter row pattern).
4. Findings resolve by re-running evaluation, not manual dismissal (ratified). A "resolved since last run" count shows progress. Manual dismiss exists behind disclosure for findings the AE judges wrong; dismissals are recorded.
5. Comments (commercial review cycle) anchor to nodes; open/resolved states, same grammar as Q&A comments.

Primary action (no blocking findings, or AE proceeds): Continue to export.

## 6. Assembly and export

Purpose: AE formats, sees the final trust summary, exports.

1. Template picker (org templates), preview of the assembled document.
2. "Generate executive summary" runs the drafting call on its dedicated node, from the finished document; it lands in the outline like any section, editable in the canvas.
3. Pre-export summary card (welcome-back modal pattern): sections, page count, claims-verified count, and the warning block if unsupported claims or gap markers remain, each listed and linked to its location. Loud but specific (ratified decision 1, option B).
4. Export requires the human click; exporting with warnings requires a second explicit confirm ("Export anyway"). The export is recorded as a snapshot.
5. Output formats: docx and pdf at MVP.
6. After export: an outcome prompt appears on the pursuit ("Mark as won / lost / no decision") and stays until answered. A win queues sections into the promotion queue. This is how the closed loop gets fed.

Primary action: Export.
