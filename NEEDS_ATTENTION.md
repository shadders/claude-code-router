# NEEDS_ATTENTION

## Open

### Bug / needs investigation: single-file OAuth credential bind mount goes stale on host token rotation

**What happened:** Deployed CCR via `docker compose up -d --build` (loopback-only port
per `docker/README.md`), and used the `ccr-local-agent-claude-code-oauth` plugin
(`getLocalAgentProviderCandidates` / `importLocalAgentProvider` RPC methods) to import
this host's real Claude Code CLI OAuth login as a Provider, so gateway traffic draws on
the Pro subscription rather than a separate API key. This required adding a bind mount
CCR didn't ship with by default: the container only sees its own `/data` as `HOME`, so
`scanClaudeCodeLogin()` can't see the host's `~/.claude/.credentials.json` at all unless
something is mounted in. Added to `docker-compose.yml`:

```yaml
volumes:
  - ${HOME}/.claude/.credentials.json:/data/.claude-host/.credentials.json:ro
environment:
  CLAUDE_CONFIG_DIR: /data/.claude-host
```

This worked for the first import. But every subsequent smoke-test request failed with
a genuine upstream `401 OAuth access token has been revoked` — not a config mistake,
confirmed by comparing sha256 hashes of the token CCR had cached (in
`config.providerPlugins[].auth.headers.authorization`) against the current token in the
live `~/.claude/.credentials.json` on the host: they didn't match, even though the
cached token's own `expiresAt` field still had ~7.8 hours left on it. Re-running
`importLocalAgentProvider` inside the *same* running container reproduced the exact
same (stale) hash every time, never the host's current one.

**Root cause (confirmed):** Docker single-file bind mounts pin to the source file's
inode at mount time. Claude Code CLI rotates its OAuth access token by writing a new
temp file and renaming it over `.credentials.json` (an atomic-replace pattern, not an
in-place edit) — that rename creates a new inode at the same host path, but the
container's bind mount keeps resolving to the old, now-orphaned inode. `docker compose
up -d --force-recreate` (which re-establishes the bind mount) immediately picked up the
host's current token — verified by hash match before vs. after recreate. The rotation
itself was almost certainly triggered by an unrelated, concurrently-running Claude Code
CLI session on this same host sharing the same credential store, not by anything CCR or
this setup did.

**Practical implication:** the imported OAuth provider will silently go stale --
returning `401 authentication_error` from Anthropic, correctly surfaced by CCR as "All
target providers failed" -- any time the host's Claude Code CLI rotates its token while
the CCR container is already running, for as long as any other process on the host
(another CLI session, a cron job, anything reading the same credential store) can
trigger that rotation. There's no live-reload here: fixing it requires either
re-creating the container (not just re-running the RPC import, which reads the same
pinned inode) or switching the mount to bind the parent `.claude` *directory* rather
than the single file (directory bind mounts do follow renames within the directory,
unlike single-file mounts) -- the latter trades this staleness problem for exposing
more of `~/.claude` to the container than just the credentials file. Neither was
implemented; this needs a decision, not a guess, before this import path is relied on
for anything longer-running than a manual smoke test.

**Also found, fixed in this session, documented here to avoid re-discovering it:**
`claudeCodeCandidate()`'s default model list is hardcoded to `["claude-sonnet-5"]`
(`packages/core/src/agents/local-providers/claude-code.ts`), but the real Claude Code
CLI's default main model is `claude-opus-5`. Requests for any model not in the
provider's `models` list fail routing entirely (`400 All target providers failed`,
`stage` never reaches `upstream_response` -- no provider is even attempted) before ever
reaching Anthropic. Worked around by manually adding
`claude-opus-5`/`claude-haiku-4-5-20251001`/`claude-fable-5` to the provider's `models`
array via `saveConfig` after import. A real fix would need the import candidate's
default model list to reflect the account's actual available models, or Router config
to just proxy through any model name the OAuth account is entitled to without an
allowlist.

**What was tested:** a single non-interactive `claude -p` file-creation task, and one
short multi-turn coding task (write + attempt to run a fizzbuzz script) -- both through
the `claude-local` wrapper, both eventually succeeding and independently verified on
disk (not taken on the CLI's own say-so). Both surfaced real upstream responses in
CCR's request-log RPC (`getRequestLogs`/`getRequestLogDetail`) -- genuine Anthropic
`request_id`s, real `rate_limit_error` and `authentication_error` payloads, real token
counts once traffic succeeded.

**What was NOT tested:** persistent multi-turn/long-running sessions (only two short
one-shot invocations were run), streaming edge cases (both smoke-test calls were
non-streaming from the harness side; the CLI's own traffic showed `isStream: true` in
the logs but wasn't specifically stressed), and heavier tool-call-dense sessions beyond
the one fizzbuzz task. The Bash tool specifically was never approved end-to-end in this
session (`--permission-mode acceptEdits` covers file edits, not shell commands) -- the
fizzbuzz task's `python3 fizzbuzz.py` run was left pending approval, and the model
correctly declined to fabricate output it hadn't actually seen rather than guess.

**Context-repetition data point (for the diffing-feature decision):** across the 6
successful (`200`) requests logged during the two smoke tests, raw request body size
was consistently ~90-101 KB, but `inputTokens` (Anthropic's own count of genuinely new,
non-cached tokens) was **2** on every single turn. Almost the entire body on every
request is repeated/cached context: `cacheReadTokens` grew from 0 (first turn, cold
cache) up to ~36,243 by the sixth turn, with `cacheWriteTokens` shrinking turn over turn
(36,243 -> 265 -> 6,251 -> 421 -> 106 -> 182) as more of the system prompt/tool
schemas/history became cache hits rather than fresh cache writes. In other words: for a
short 6-turn session, essentially 100% of the token volume on later turns is exact
repeated context (system prompt + full prior turns), not new content -- this is the
real-world number the diffing-feature strategy discussion should use, not a guess.

**Judgment calls made during setup (flagging per this file's own convention, since none
of these were spec'd in the task):**
- Used `${HOME}/.claude/.credentials.json` bind-mounted read-only rather than the whole
  `~/.claude` directory, to minimize what the container can see of host state -- this is
  what caused the inode-pinning staleness bug above; a directory mount would avoid that
  specific bug but expose more.
- Enabled `observability.requestLogs` (was `false` by default) so the Logs UI/RPC would
  actually capture anything -- this is a config change beyond pure "observe traffic",
  worth knowing about if a stricter no-logging default was assumed.
- CCR requires its own client API key (from the auto-created "Local Gateway" APIKEYS
  entry) for anything hitting the gateway, entirely separate from the imported OAuth
  provider credential (that credential authenticates CCR -> Anthropic upstream, not
  `claude` CLI -> CCR downstream). The task's original plan assumed a pure
  `ANTHROPIC_BASE_URL` swap would be enough; it isn't -- `ANTHROPIC_API_KEY` also has to
  be set to CCR's client key for the CLI to authenticate to the gateway at all
  (confirmed via nginx access log: 8 real `401` retries from `claude-cli` before this
  was diagnosed). This key is stored at `~/.ccr_client_key` (`chmod 600`, not in this
  repo, not in `~/.bashrc`) and read at invocation time by the `claude-local` wrapper
  function in `~/.bashrc`.
- Config was applied via CCR's RPC endpoint (`/api/ccr/rpc`, `getConfig`/`saveConfig`/
  `importLocalAgentProvider`/etc.) rather than through the management Web UI in a
  browser, since the available browser-automation tool for this session runs on a
  different physical machine than the one hosting CCR's loopback-bound port and
  couldn't reach it. Functionally equivalent -- same RPC methods the UI itself calls --
  but means the provider-plugin placeholder substitution
  (`__CCR_PROVIDER_NAME__`/`__CCR_PROVIDER_NAME_SLUG__`/`__CCR_PROVIDER_INTERNAL_NAME__`)
  normally done by `packages/ui/src/pages/home/App.tsx`'s
  `materializeProviderPluginTemplates()` had to be reimplemented by hand to match it
  exactly. Worth a from-the-UI pass at some point to confirm parity.
