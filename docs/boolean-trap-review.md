# Four TypeSafe boolean-trap warnings

The rule asks whether several positional boolean flags appear together in one call or signature. The benchmark recorded a file and rule for each warning, without a model-selected source span. These judgments come from comparing the reviewed revisions against their bases.

| PR | What changed | Review judgment |
| --- | --- | --- |
| [#2](https://github.com/ckorhonen/jev-lint/pull/2/files) | Two new wrappers each pass one positional boolean to `judgeJev`. | False positive. Separate calls do not combine into one trap. |
| [#3](https://github.com/ckorhonen/jev-lint/pull/3/files) | The new `judgeDecisions` wrapper passes one positional boolean to `judgeJev`. | False positive. |
| [#5](https://github.com/ckorhonen/jev-lint/pull/5/files) | The Claude and Codex `writeConfig` calls move into a try block with the same arguments. | Existing API issue. The edit introduces no new flag burden. |
| [#14](https://github.com/ckorhonen/jev-lint/pull/14/files) | The Codex call now passes an explicit `false` after two flag values to reach a new trailing root argument. | Actionable. Named options would let the caller specify the root and omit the default flag. |

All four were offline replays. Author response and warning-attributed fixes are unknown for all four. The table records a retrospective assessment and leaves the original benchmark labels intact.
