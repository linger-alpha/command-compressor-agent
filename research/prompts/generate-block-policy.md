You are generating deterministic block-compression policy candidates for a coding-agent shell-output compressor.

The input contains bounded, locally redacted blocks sampled from training sessions. It never contains a complete trajectory. Produce only JSON matching the supplied schema.

`sample_class` is a local structural label used only to balance the sample across sources and block shapes. It is not a tool parser, score, or required production rule.

The runtime has three tiers:

- preserve: retain every line after ANSI removal and local secret redaction
- light: static keep/strip rules, duplicate folding, and conservative head/tail retention
- aggressive: progress removal, static keep/strip rules, duplicate folding, and tighter head/tail retention

Hard requirements:

1. Keep these exact safety signals in every candidate:
   - opaque_encoded, kind opaque_encoded, tier preserve
   - dense_semantic, kind dense_semantic, tier preserve
   - visual_structure, kind visual, tier preserve
   - traceback_exception, tier preserve, with a regex matching Exception, common names ending in Exception, and Traceback
   - error_failure, tier preserve, with a regex matching ERROR, fatal, FAILED, and common Error/Failure class names
   - critical_runtime_failure, tier preserve, with a regex matching real timeout failures, panic, OOM, segmentation faults, missing/denied files, undefined references, npm ERR, and Command failed; it must not match a CLI option merely because its name contains --timeout
2. Base64, encoded/binary-looking data, PEM material, hex dumps, dense semantic lists, visual matrices, tracebacks, and errors must not be compressed.
3. Do not add tool-specific parsers or name pytest, npm, cargo, or another particular framework in a signal.
4. Use only auditable regular expressions. Do not use lookbehind, backreferences, or nested unbounded quantifiers.
5. Derive the remaining tiers and planner values from the supplied blocks. Favor the smallest policy that explains repeated evidence.
6. A preserve signal has precedence over all lower tiers. Do not rely on signal ordering to override safety.
7. The default tier may be light or aggressive, never preserve.
8. Give each candidate a distinct policy_id. Rationale is research-only and will never enter the npm package.
9. For a kind signal, set pattern and flags to empty strings. For a regex signal, set kind to an empty string.
10. JavaScript does not support inline flag groups such as (?im). Put i and/or m only in the separate flags field.
11. Every regex source must be shorter than 480 characters and compile exactly with `new RegExp(pattern, flags)`. Prefer short word-boundary alternatives over an exhaustive expression.

Rejected-candidate complaints may be included in the input. Make a more conservative replacement when a prior candidate lost information; do not merely rename it.
