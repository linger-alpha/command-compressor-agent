# Static compression rule candidate generation

Generate conservative JSON rule candidates for a deterministic command-output compressor.

Constraints:

- Work only from the bounded, locally redacted command/output samples in the input JSON.
- Never ask for, infer, or reconstruct a complete trajectory.
- Produce regular-expression rules, never executable code, summaries, embeddings, or model calls.
- Every regex must compile with `new RegExp(pattern)` in Node.js 18 using ECMAScript syntax. Never use inline flags such as `(?i)`, `(?m)`, or `(?s)`, and never use Python anchors such as `\A` or `\Z`.
- `trigger_regex` is matched against the complete command without implicit flags. `output_regex` is matched against the complete output with multiline mode.
- Every `keep_patterns` and `strip_patterns` entry is evaluated against one line at a time without implicit flags. Do not emit multiline strip patterns. Spell out required case variants in the expression.
- Preserve errors, exceptions, traceback lines, file/line references, warnings, success/failure summaries, and final outcomes.
- Prefer a narrow trigger and narrow strip patterns. A false negative is safer than a false positive.
- Treat `frozen_failures` as complaints from earlier rounds. Any replacement must be narrower and more conservative.
- Return only data conforming to the supplied JSON Schema.
