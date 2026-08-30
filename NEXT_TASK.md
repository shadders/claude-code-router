# Next task: router UI patches, then backlog if quota allows

Read ztl-workflow's WORKFLOW_GUIDE.md first if you haven't this session (clone
https://github.com/shadders/ztl-workflow, same token). Follow its unattended-work
rules: number items, commit+push after EACH item, do not wait for confirmation
between items, log blockers to NEEDS_ATTENTION.md rather than guessing, state
upfront what will look incomplete by design.

Before starting: read this repo's own NEEDS_ATTENTION.md entry from the prior
session's pass-through smoke-test task (deploy + configure + real traffic look).
It should have real observations about how much of a typical request is repeated
context vs. new content — use that, not a guess, to sanity-check the patches
below actually target the real noise. If that entry isn't there yet or the prior
task didn't finish, note that and proceed anyway on the patches — they don't
strictly depend on it, the diffing feature (explicitly out of scope here) is what
depended on it.

## PRIMARY — this is the actual point of the run

Patch this fork (https://github.com/shadders/claude-code-router, same token),
commit as a separable series (one commit per item below, not squashed), rebuild
the Docker image, redeploy on whichever host the prior task actually used (check
its NEEDS_ATTENTION.md entry — don't assume dev machine vs beastus).

1. **Compaction call-type tagging.** Claude Code's native auto-compact request is
   detectable by exact substring match — see `isClaudeCodeAutoCompactPromptText`
   in `packages/core/src/gateway/context-archive/protocol.ts` (matches three
   fixed strings in a user message: "CRITICAL: Respond with TEXT ONLY. Do NOT
   call any tools.", "Your task is to create a detailed summary of the
   conversation so far", "Your entire response must be plain text: an
   <analysis> block followed by a <summary> block."). That function isn't
   exported — either export and reuse it, or duplicate the matcher in the
   observability path (`packages/core/src/observability/`), whichever is
   cleaner given the module boundaries you find. Use it to set a `call_type`
   (or equivalent field) of "compaction" on the log entry, surfaced in
   `network-logs.tsx`'s row rendering.

2. **Separate system-prompt panel.** Extract the `system` field (Anthropic
   Messages) into its own section, shown once per session/page rather than
   repeated on every row, collapsed by default. Trim it out of the per-row
   request preview and Tier 1 view — it should still be present in Tier 2 (the
   full raw wire payload), since that's meant to be ground truth.

3. **Human-readable context size.** Format token/size counts as "42k" not
   "42123" wherever request/response size renders in the log UI. Look at
   `formatLogTokenSummary` and similar existing formatters as the pattern to
   extend rather than introducing a second formatting convention.

4. **Tier 1 request/response independently collapsible.** In
   `LogExpandedDetails` (network-logs.tsx), make the request pane and response
   pane each collapsible on their own, not just the row as a whole.

Explicitly NOT in scope here: diffing against previous-turn context. That's a
deliberate future task once there's more real traffic to design it against.

After each patch: rebuild, redeploy, and actually look at the running UI to
confirm the change renders correctly against real logged data — don't commit
on the strength of the code compiling. Per this project's verify_dont_trust
principle, check the specific thing each patch claims to do, not general
appearance of correctness.

## SECONDARY — only if quota remains after 1-4 are done and verified

These live in https://github.com/shadders/ztl-llm-fleet (same token), not this
repo. Numbered continuing from above, same unattended rules apply.

5. `harness/eval/agentarch_live.py`: add the explicit decision-phrasing
   instruction to SYSTEM_PROMPT. Ground-truth phrase families (already
   confirmed, don't re-derive): `requesting_time_off` -> "Request approved"/
   "Request rejected"; `customer_request_routing` -> "Case created"/"No new
   case created" (pull exact wording from local_data/eval-datasets/agentarch
   if you need to double check). This is a real prompt change — note in
   NEEDS_ATTENTION that any run using it isn't directly comparable to prior
   partial-sample runs.

6. `harness/eval/mlflow_import.py`: give it an explicit local_data/-based
   default artifact-storage root instead of relying on cwd-relative `./mlruns/`.

7. Investigate (don't necessarily fix) AgentArch's Track A record 9
   (`customer_request_routing`, label `coder30b-gpu1`) which produced an empty
   `final_message`. Read the real wire log at
   local_data/api-call-logs/agentarch-coder30b-gpu1/ and document what actually
   happened in NEEDS_ATTENTION.md.

8. Add a per-entry `gpu_memory_utilization` override field to `ModelEntry`,
   following the same optional-field pattern already used for
   `pp_layer_partition`/`tokenizer_mode`.

9. `model-hosting/switch_model.py`'s `wait_for_startup`: add at least one retry
   before treating a single failed `docker inspect` SSH poll as definitive
   failure. This touches the beastus SSH control path directly — be
   conservative, verify against a real redeploy that the retry doesn't mask an
   actual failure, don't just reason about it.

10. Migrate the opencode sandbox workspace from /mnt/qvo8/opencode-workspaces/
    back to /home/shadders/ (the ZFS issue that forced the original move is
    resolved). This directory holds two live GitHub fine-grained PATs
    (proxy-substituted via sbx, plus raw token files at
    opencode-secrets/*-token on the host) and a running sbx container — treat
    as real infrastructure surgery, not a plain `mv`: stop the container,
    VERIFY it's actually stopped (don't take a stop command's exit code as
    proof), move the data, re-point any config that hardcodes the old path,
    restart, and verify the container is genuinely healthy against the new
    path before calling this done. If anything about the current setup is
    ambiguous, stop and log rather than guess — this one has real blast radius.

Stop and log rather than guess on any item if requirements are ambiguous or a
tool/credential doesn't work as expected after one retry.
