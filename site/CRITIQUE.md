# jevlint.dev: design critique (27 Sep 2026)

This is an Impeccable `critique` run with two isolated passes. The first was a design review from the source plus screenshots at 1440, 1280, 390 and 360 px. The second was a detector plus browser measurements. The CLI detector ran degraded (its HTML parser modules are missing), so the browser detector's results are the ones that count.

The screenshots are in `critique/`. The ones named `after-*` were taken after the fixes listed at the end.

**Score:** 27/40 on Nielsen's heuristics.

**Verdict:** the page is about 70% specific to this product. The hero terminal, the rules written as `//` comments, the stopwatch and the strict red/green colours are specific to jev-lint. The structure underneath is a stock SaaS template with numbered slides: every section is a full-height card, and two sections of three identical cards sit back to back.

## Priority issues

| # | Sev | Issue | Evidence | Fix |
|---|---|---|---|---|
| 1 | P0 | **The mobile terminal breaks.**<br>• At 360/390 the hook header squashes to "jev- / lint".<br>• Code is clipped.<br>• The title bar wraps.<br>• The height jumps when the fix adds lines. | `before-360-terminal.webp` | • Wrap the header.<br>• Hide the title-bar label on narrow screens.<br>• Fix the code block's minimum height. |
| 2 | P1 | **It reads as a slide deck, not a story.**<br>• Sections use `clamp(72px,11vw,150px)` top and bottom, so there are about 300 px gaps at 1440.<br>• 10 H2 sections at up to 66 px, each under a numbered HUD label with floating corner marks.<br>• The page is 11,224 px at 1440, about 12.5 screens; the rules section alone is 1.9 screens. | `before-1440-gap.webp` | • Half the section padding; smaller H2s.<br>• Drop the HUD labels and corner marks.<br>• Merge the two card sections.<br>• Add connecting lead-ins so it reads as one argument. |
| 3 | P1 | **The H1 runs 4 lines at 1440** (70 px in a 566 px column) but 3 lines at 1280. | `before-1440-hero.webp` | Give the H1 its own full-width row above the grid. |
| 4 | P1 | **The copy button uses a green offset shadow.** It's the only green on the page that doesn't mean "fixed", and the hard 6 px offset is a neobrutalist costume. | `before-1440-hero.webp` | • Grey offset at rest; green only in the copied state.<br>• Lift the button above the vignette overlay. |
| 5 | P1 | **The ⌘C badge promises a shortcut that doesn't exist.** `app.js` has no key handler, and the badge means nothing on phones. | hero | Remove the badge. |
| 6 | P2 | **The review-loop diagram appears all at once.** It fades in as a single block and only shows the bad path. | `before-1440-problem.webp` | • Draw the boxes and connectors in sequence, then the caption.<br>• Add a second, green row showing the path with jev-lint. |
| 7 | P2 | **Eyebrows and section numbers add noise.**<br>• The hero kicker is all caps.<br>• "01 · THE PROBLEM" and the like, plus counters on the right that repeat the heading. | all sections | Delete them; the headings carry the page. |
| 8 | P2 | **The video poster is the end card,** so the demo looks like a title slide and the real end card repeats it. | `d1440-03` | Use the frame where the red finding appears as the poster. |
| 9 | P2 | **Mobile touch targets are under 44 px.**<br>• Agent toggle: 36 px.<br>• Nav links: 22 px.<br>• Inline links: 20–26 px.<br>• "Run it again": 40 px. | detector measurements | Set a 44 px minimum on the controls and pad the nav and links. |
| 10 | P2 | **The terminal loops forever with no pause** (WCAG 2.2.2). The terminal label also stays "Claude Code" after choosing Codex. | hero | • Add a pause control.<br>• Label the terminal with the selected agent. |
| 11 | P3 | **Detector findings, all minor:**<br>• 3 px grey `border-left` on the honest-note callout (side-tab).<br>• Thin border with a 120 px blur shadow on the terminal.<br>• Line-number gutter `#444` at 2.0:1.<br>• `.src` and `.trip` lines about 115 characters long.<br>• An amber colour used once, outside the colour tokens. | detector | • Full hairline box for the callout.<br>• Offset, soft shadow on the terminal.<br>• Gutter `#6e6e6e`.<br>• Limit measure to 72ch.<br>• Make the amber an `--amber` token. |
| 12 | P3 | **Browser defaults:** text selection, the scrollbar and the caret aren't themed. | — | Theme them from the palette. |

## Desktop vs mobile

- **1280** is the best-balanced viewport: the H1 sits at 3 lines and the terminal fits beside the copy.
- **1440** is worse than 1280. The font grows while the column doesn't, which gives a 4-line H1, and the CTA drops below the fold.
- **390 and 360**:
  - The hero stacks well, but the terminal breaks (issue 1).
  - The page is longer than on desktop (12,000–12,500 px) because the H2s keep a 32 px minimum and the padding stays generous.
  - The hero alone is 1.9 screens.
- There's no page-level horizontal overflow at any width, and Departure Mono loads everywhere.

## What's working

- **The hero terminal is the product.** It replays a real finding (`react-effect-fetch-race`) and then its fix, so the page shows rather than tells.
- **Colour discipline and honesty:**
  - Red means flagged and green means fixed or hook on.
  - There's an explicit note that an AI reviewer still ran a review round.
  - Numbers carry their run counts, and source lines sit under the claims.
- **The problem copy:** "There's no regex for 'this effect only derives state'."

## Persona red flags

- **Sceptical senior engineer:** "0.3 s" appears 6 times and "170" three times, which reads as marketing. The ⌘C badge that doesn't work costs credibility.
- **First visit on a phone:** the first product they see is the broken terminal, and ⌘C is meaningless on a phone.
- **Codex user:** after choosing Codex, the terminal still says "Claude Code".

## Changes made in response (see git history)

- **Owner decisions:**
  - The H1 is at most 3 lines at 1280 and above (2 lines in practice); 3 on mobile.
  - The copy button has a grey offset at rest and turns green only when copied. The key badge is gone.
  - GitHub links carry the GitHub mark.
  - The numbered HUD headers and corner marks are gone.
  - The review diagram draws in sequence: boxes, connectors, the red nodes, then the caption. The green jev-lint path follows.
  - The layout is tightened into one narrative:
    - section padding is roughly halved;
    - "Your rules" and "How it works" are merged, and "How it works" now comes before the proof;
    - the results, cost and speed sections are grouped as one proof;
    - short lead-ins connect the sections.
- **Other critique fixes applied:** 1, 7, 8, 9, 10, 11 and 12.
- **The hero terminal has a fixed size.** The code area is always 13 lines tall, and every hook state is rendered up front in one grid cell. The window never grows while it types, flags or fixes: its height stayed constant at 1440/1280/390/360 and with reduced motion, and CLS was about 0.
- **Edit-vs-review economics reframed** to match the README ("Does it pay for itself…"):
  - Rule-covered review comments went from 1.33 to 0.79 per task (−41%; 95% CI of the change −1.08 to −0.04).
  - Fixing at the edit costs about +$0.04 and a few seconds, against about $0.18 and 70 s for a review round.
  - With human reviewers the saving is direct.
  - One small line notes that reviews still find logic and design issues.
- **Newer figures added (notebook Entry 7 and `eval/results`):**
  - 2.71 → 1.54 violations per task with all 170 rules (48 runs, −43%).
  - About 0.23 s per check with the warm connection (median 228 ms on a quiet Mac).
  - Per-pack held-out precision of 91–100%, with 0–4% of clean edits flagged.
