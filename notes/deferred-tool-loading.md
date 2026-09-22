# Deferred tool loading does not work through a Bifrost gateway

Measured 2026-09-04 against `gateway/claude-opus-5` (Bifrost → Bedrock,
`us.anthropic.claude-opus-5`).

Pi supports Anthropic's deferred tool loading — `docs/extensions.md`, "Dynamic
Tool Loading": an extension keeps a loader tool active and calls
`pi.setActiveTools()`; pi then emits `defer_loading: true` on the schemas and a
`tool_reference` block at the load point. For a custom provider it is gated
behind `compat.supportsToolReferences: true` in `models.json`, which the docs
say to enable only for an endpoint verified to accept the protocol.

**This endpoint does not.** One fat tool schema, identical request otherwise:

    no beta header, defer      200   input_tokens = 3,190
    beta header, defer         200   input_tokens = 3,190
    beta header + tool_search  200   input_tokens = 3,190
    control, no defer          200   input_tokens = 3,190

Every variant is billed the same. `defer_loading: true`, the
`advanced-tool-use-2025-11-20` beta header and the
`tool_search_tool_regex_20251119` server tool are all accepted with 200 and all
have no effect on what is counted. A `tool_reference` load point inside a
`tool_result` also returned 200 rather than the
`Tool reference '...' not found in available tools` 400 that Claude Code hits on
Bedrock (anthropics/claude-code#25212) — so the block is most likely dropped
before Bedrock sees it. Whether Bifrost strips it or Bedrock ignores it was not
distinguished; the outcome is the same either way.

**Do not set `compat.supportsToolReferences: true`.** Left at its default the
flag makes pi use the safe fallback — send the whole active tool list — which is
the correct behaviour here. Turning it on would reproduce the Claude Code bug:
pi would withhold definitions expecting a deferral that never happens.

Re-test if the gateway moves off Bedrock, or if Bifrost adds passthrough for the
advanced-tool-use beta. Until then the ~6,700 tokens of tool schemas in the
startup context can only be cut by having fewer tools, not by deferring them.
