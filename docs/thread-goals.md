# Thread goals

Thread goals are a provider-neutral ShioriCode orchestration feature. Codex,
Claude Agent, Kimi Code, Gemini, GLM, and Cursor all use the same durable
lifecycle. Provider adapters transport ordinary input and runtime events and
register the harness tool, but they do not own goal state or continuation.
Providers can read the current snapshot and report a terminal outcome only
through the authenticated ShioriCode control path.

The interaction design and safety invariants were informed by the official
[OpenAI Codex implementation](https://github.com/openai/codex) (reviewed at
commit `726b6378d2513c25e5e59b1371326be2fe194be4`). ShioriCode does not call or
adapt to Codex's native goal API.

## Ownership boundary

The durable flow is:

```text
client command
  -> ShioriCode orchestration fact
  -> thread projection / SQL
  -> harness-rendered goal context
  -> ordinary provider turn
```

- `thread.goal.set` directly emits `thread.goal-updated`.
- `thread.goal.clear` directly emits `thread.goal-cleared`.
- A composer goal start atomically persists `thread.message-sent`, a fresh
  `thread.goal-updated`, and `thread.turn-start-requested`, in that order.
- A goal steer uses the same message, goal fact, then steer-request ordering.
- Provider turn and runtime contracts contain no provider-owned goal field,
  goal RPC, or goal event.
- Goal accounting, status reports, and continuation are internal orchestration
  commands guarded by the current ShioriCode lifecycle ID.

Direct factual events are intentional. Domain-event streams are hot and are not
replayed, so persisting a request and relying on a later reactor to create the
goal would lose state if the server stopped between those operations.

## Provider delivery

Immediately before a send or steer, orchestration re-reads the projected goal.
An active goal in default interaction mode is rendered into the ordinary text
input. The objective is XML-escaped inside an `untrusted_objective` delimiter;
it is user data, not a higher-priority instruction. Rendering happens before
provider input validation, so the final payload must satisfy the same limits as
any other turn.

Paused, blocked, usage-limited, budget-limited, complete, and plan-mode turns do
not receive active-goal context. Attachments follow the provider's normal
attachment path unchanged.

A user edit to an active goal is persisted immediately. If Codex already has a
turn running, the harness sends the revised goal through Codex's ordinary steer
operation. The other five providers do not have a reliable equivalent, so
their current physical turn is left alone and the revised goal is rendered on
the next turn. Setting or resuming an active goal while the thread is idle
requests a continuation without a synthetic user message.

When the web client queues a user turn behind a running turn, it first
compare-and-set pauses the active goal. Projection of that pause precedes the
provider interrupt; the queued message is sent after the running turn stops.
An ordinary queued message leaves the goal paused. A queued message carrying a
new goal intent creates its new lifecycle when it is dequeued.

## Built-in provider tool

Every Codex, Claude Agent, Kimi Code, Gemini, GLM, and Cursor session receives
the same built-in `shioricode-thread-goal` stdio MCP server. It exposes only
`get_goal` and `update_goal`; adapters register that transport but do not own
the state it reads or changes. The MCP subprocess calls a local ShioriCode
control route with a process-lifetime HMAC capability scoped to exactly one
thread. The route derives the thread from that capability, requires the tool's
`goal_id` to match the current lifecycle, and permits tool reports only for
`complete` or `blocked`. Plan-mode updates are rejected while the goal is
dormant. The built-in server name is reserved
case-insensitively and overrides user configuration with the same name.

Codex is launched with `features.goals=false`. Native goals are stable and
enabled by default upstream, so this override prevents a goal in Codex's local
state from starting hidden turns alongside ShioriCode's lifecycle. Its
ShioriCode MCP entry is marked required and auto-approved. Provider-native goal
notifications are rejected rather than projected; ShioriCode does not adapt
to the Codex goal lifecycle.

Provider session replacement is transactional at the harness boundary. A new
runtime must reach its provider-specific readiness check before it can replace
the tracked runtime. A provider-start failure cleans the staged process and MCP
resources while leaving the old session routable. A successful provider start
silently retires the exact old runtime so its delayed exit cannot demote the new
session. ProviderService serializes same-thread start, recovery, stop, and exit
revocation; capability rotation commits only after the replacement binding is
durable. If binding persistence fails after provider startup, the replacement
is stopped and its capability is revoked. Disabling a provider takes an
exclusive provider transition barrier so it cannot miss a session that is still
starting.

Startup reconciliation waits for the routed HTTP application, not merely an
open listening socket. The thread-goal control handler is therefore installed
before a recovered continuation can start a provider that immediately invokes
`get_goal` or `update_goal`.

## State, lifecycle, and accounting

Goal snapshots live in the thread SQL projection. Migration 030 reconstructs
the latest historical ShioriCode goal fact.

Creating a goal through a composer goal intent creates a fresh lifecycle with
zero counters and a new `createdAt`. For an existing goal, changing the
objective or successfully moving a non-active goal back to `active` rotates
the `lifecycleId`. Those edits deliberately preserve `tokensUsed`,
`timeUsedSeconds`, and the original `createdAt`; the lifecycle ID is a
compare-and-set generation, not the start of a new accounting history. Other
status or budget edits keep the current lifecycle ID.

For an existing goal, the web client supplies `expectedGoalLifecycleKey` on
set and clear commands. Internal usage, status-report, and continuation
commands always require it, and `update_goal` must provide the exact current
`goal_id`. A stale generation is rejected, so stale tool reports, usage
commands, and continuation requests cannot mutate or charge a revised or
reopened goal.

Adapters may report a generic `processedTokensDelta` as part of ordinary usage
normalization. The harness binds each physical turn to the lifecycle active at
turn start and records normalized token deltas and wall time against it.
That binding, rather than the thread's interaction mode at terminal time,
decides whether later usage, failure, or abort events belong to the goal. The
current running binding is reconstructed when ingestion restarts.
Replayed provider events use deterministic command IDs and cannot increment
counters twice. Reaching a configured token budget transitions an active goal
to `budgetLimited`.

Public clients can set only `active`, `paused`, or `complete`. Limit and blocked
states remain harness-owned.

A public `paused` transition is accepted only from `active`. This prevents a
same-lifecycle browser update that was rendered just before provider completion
from overwriting the authoritative terminal status.

## Terminal and error matrix

The following mappings apply to an active goal and lifecycle events accepted
by the strict provider/turn guard. Stale provider events are ignored, and goal
commands still have to pass the lifecycle compare-and-set check.

| Trigger                                                                                                  | Harness result                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `update_goal(..., complete)`                                                                             | `complete`                                                                         |
| Successful `turn.completed` while the goal remains active                                                | Keep `active` and persist a continuation request                                   |
| Failed `turn.completed`, session error, abnormal session exit, or `runtime.error` owned by the goal turn | `usageLimited` when the reason is recognized as a usage limit; otherwise `blocked` |
| Graceful provider-session replacement while the goal remains active                                      | Keep `active` and persist a continuation request after the old session stops       |
| Interrupted or cancelled `turn.completed`, or `turn.aborted`                                             | `paused`                                                                           |
| Initial goal send or later continuation dispatch failure                                                 | `blocked`                                                                          |
| User pause, turn interrupt, session stop, or queuing a user turn while a goal turn runs                  | `paused`                                                                           |
| Thread archive                                                                                           | Atomically `paused` before the archive fact                                        |
| Configured token budget reached                                                                          | `budgetLimited`                                                                    |
| User marks the goal complete                                                                             | `complete`; interrupt a running provider turn and finalize when idle               |
| User clears the goal                                                                                     | Remove the goal and interrupt a running provider turn                              |

A complete goal finalizes assigned Kanban work and stops automation sessions.
Idle completion is reconciled on reactor startup, making these side effects
recoverable after a crash. An active incomplete goal defers those logical
completion effects when a physical provider turn ends.

## Continuation semantics

Completion is never inferred from assistant prose. During an active goal, the
harness tells the provider to report `complete` or `blocked` through the
structured ShioriCode tool using the exact lifecycle ID. A successful physical
turn whose goal remains active emits a durable continuation fact. Once the
thread is idle, the command reactor starts another ordinary provider turn with
the current harness-rendered context and no synthetic user message. This is the
same path for Codex, Claude Agent, Kimi Code, Gemini, GLM, and Cursor.

The loop stops when the goal is complete, blocked, paused, usage-limited,
budget-limited, cleared, or the thread is in plan mode. Entering plan mode does
not rewrite the goal status; it suppresses goal context and automatic
continuation until the thread returns to default mode.

Continuation requests and goal state are durable, and reactor startup
reconciles active idle goals that could otherwise be stranded by a restart.
Within a running server, one per-thread dispatch latch closes the provider
projection window and a bounded source-turn tombstone suppresses delayed
duplicate continuation facts.
There is necessarily an at-least-once edge at the external provider boundary:
if the server exits after a provider accepts a turn but before ShioriCode sees
its start event, recovery may submit the continuation again. Provider APIs do
not expose a common idempotency key that can eliminate that uncertainty.

## Validation

- Objectives are trimmed, nonempty, XML-escaped when rendered, and limited to
  4,000 Unicode scalar values.
- A token budget is either `null` or a positive integer.
- Budget patches are tri-state: omitted keeps the current budget, `null` clears
  it, and a positive integer replaces it.
- Turns that start in plan mode cannot create or account for a goal.
