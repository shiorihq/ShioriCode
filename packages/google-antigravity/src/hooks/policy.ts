import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { BaseMcpServerConfig, BuiltinTools, HookResult, ToolCall } from "../types.js";
import { PreToolCallDecideHook, HookContext } from "./hooks.js";

export type Predicate =
  | ((args: Record<string, unknown>) => boolean | Promise<boolean>)
  | ((toolCall: ToolCall) => boolean | Promise<boolean>);
export type AskUserHandler = (toolCall: ToolCall) => boolean | Promise<boolean>;
type PolicyOptions = { when?: Predicate; name?: string };
type AskUserOptions = PolicyOptions & { handler: AskUserHandler };
type EnforceOptions = {
  mcpServers?: BaseMcpServerConfig[];
  mcp_servers?: BaseMcpServerConfig[];
};

const WILDCARD = "*";

export enum Decision {
  APPROVE = "APPROVE",
  DENY = "DENY",
  ASK_USER = "ASK_USER",
}

export class Policy {
  tool: string;
  decision: Decision;
  when?: Predicate;
  askUser?: AskUserHandler;
  name = "";

  constructor(init: {
    tool: string;
    decision: Decision;
    when?: Predicate;
    askUser?: AskUserHandler;
    ask_user?: AskUserHandler;
    name?: string;
  }) {
    this.tool = init.tool;
    this.decision = init.decision;
    this.when = init.when;
    this.askUser = init.askUser ?? init.ask_user;
    this.name = init.name ?? "";
  }

  get ask_user(): AskUserHandler | undefined {
    return this.askUser;
  }

  set ask_user(value: AskUserHandler | undefined) {
    this.askUser = value;
  }
}

function mcpPolicies(
  decision: Decision,
  mcpConfig: BaseMcpServerConfig,
  mcpTools?: string[],
  options: PolicyOptions & { handler?: AskUserHandler } = {},
): Policy[] {
  const server = mcpConfig.name;
  if (mcpTools === undefined) {
    return [
      new Policy({
        tool: `${server}/*`,
        decision,
        when: options.when,
        name: options.name ?? `${decision.toLowerCase()}_${server}_all`,
        askUser: options.handler,
      }),
    ];
  }
  return mcpTools.map(
    (tool) =>
      new Policy({
        tool: `${server}/${tool}`,
        decision,
        when: options.when,
        name: options.name
          ? `${options.name}_${tool}`
          : `${decision.toLowerCase()}_${server}_${tool}`,
        askUser: options.handler,
      }),
  );
}

function normalizePolicyArgs(
  mcpToolsOrOptions?: string[] | PolicyOptions | string,
  options: PolicyOptions = {},
): { mcpTools?: string[]; options: PolicyOptions } {
  if (typeof mcpToolsOrOptions === "string") {
    throw new Error(
      `mcpTools must be a sequence of strings, not a single string '${mcpToolsOrOptions}'.`,
    );
  }
  if (Array.isArray(mcpToolsOrOptions) || mcpToolsOrOptions === undefined) {
    return { mcpTools: mcpToolsOrOptions, options };
  }
  return { options: mcpToolsOrOptions };
}

function normalizeAskUserArgs(
  mcpToolsOrOptions?: string[] | AskUserOptions | string,
  options?: AskUserOptions,
): { mcpTools?: string[]; options: AskUserOptions } {
  if (typeof mcpToolsOrOptions === "string") {
    throw new Error(
      `mcpTools must be a sequence of strings, not a single string '${mcpToolsOrOptions}'.`,
    );
  }
  if (Array.isArray(mcpToolsOrOptions) || mcpToolsOrOptions === undefined) {
    if (!options) {
      throw new Error("askUser requires a handler option.");
    }
    return { mcpTools: mcpToolsOrOptions, options };
  }
  return { options: mcpToolsOrOptions };
}

export function allow(tool: string, options?: PolicyOptions): Policy;
export function allow(
  mcpConfig: BaseMcpServerConfig,
  mcpTools?: string[],
  options?: PolicyOptions,
): Policy[];
export function allow(mcpConfig: BaseMcpServerConfig, options?: PolicyOptions): Policy[];
export function allow(
  toolOrMcp: string | BaseMcpServerConfig,
  mcpToolsOrOptions?: string[] | PolicyOptions,
  maybeOptions: PolicyOptions = {},
): Policy | Policy[] {
  const { mcpTools, options } = normalizePolicyArgs(mcpToolsOrOptions, maybeOptions);
  if (typeof toolOrMcp === "string") {
    if (mcpTools !== undefined) {
      throw new Error("mcpTools cannot be specified when tool is a string.");
    }
    return new Policy({
      tool: toolOrMcp,
      decision: Decision.APPROVE,
      when: options.when,
      name: options.name,
    });
  }
  return mcpPolicies(Decision.APPROVE, toolOrMcp, mcpTools, options);
}

export function deny(tool: string, options?: PolicyOptions): Policy;
export function deny(
  mcpConfig: BaseMcpServerConfig,
  mcpTools?: string[],
  options?: PolicyOptions,
): Policy[];
export function deny(mcpConfig: BaseMcpServerConfig, options?: PolicyOptions): Policy[];
export function deny(
  toolOrMcp: string | BaseMcpServerConfig,
  mcpToolsOrOptions?: string[] | PolicyOptions,
  maybeOptions: PolicyOptions = {},
): Policy | Policy[] {
  const { mcpTools, options } = normalizePolicyArgs(mcpToolsOrOptions, maybeOptions);
  if (typeof toolOrMcp === "string") {
    if (mcpTools !== undefined) {
      throw new Error("mcpTools cannot be specified when tool is a string.");
    }
    return new Policy({
      tool: toolOrMcp,
      decision: Decision.DENY,
      when: options.when,
      name: options.name,
    });
  }
  return mcpPolicies(Decision.DENY, toolOrMcp, mcpTools, options);
}

export function askUser(tool: string, options: AskUserOptions): Policy;
export function askUser(
  mcpConfig: BaseMcpServerConfig,
  mcpTools: string[] | undefined,
  options: AskUserOptions,
): Policy[];
export function askUser(mcpConfig: BaseMcpServerConfig, options: AskUserOptions): Policy[];
export function askUser(
  toolOrMcp: string | BaseMcpServerConfig,
  mcpToolsOrOptions?: string[] | AskUserOptions,
  maybeOptions?: AskUserOptions,
): Policy | Policy[] {
  const { mcpTools, options } = normalizeAskUserArgs(mcpToolsOrOptions, maybeOptions);
  if (typeof toolOrMcp === "string") {
    if (mcpTools !== undefined) {
      throw new Error("mcpTools cannot be specified when tool is a string.");
    }
    return new Policy({
      tool: toolOrMcp,
      decision: Decision.ASK_USER,
      when: options.when,
      askUser: options.handler,
      name: options.name,
    });
  }
  return mcpPolicies(Decision.ASK_USER, toolOrMcp, mcpTools, {
    ...options,
    handler: options.handler,
  });
}

export function allowAll(): Policy {
  return allow(WILDCARD, { name: "allow_all" });
}

export const allow_all: typeof allowAll = allowAll;

export function safeDefaults(handler: AskUserHandler): Policy[] {
  return [
    ...BuiltinTools.readOnly().map((tool) => allow(tool) as Policy),
    askUser(WILDCARD, { handler }),
  ];
}

export const safe_defaults: typeof safeDefaults = safeDefaults;

export function denyAll(): Policy {
  return deny(WILDCARD, { name: "deny_all" });
}

export const deny_all: typeof denyAll = denyAll;

export function confirmRunCommand(handler?: AskUserHandler): Policy[] {
  if (handler) {
    return [
      askUser(BuiltinTools.RUN_COMMAND, {
        handler,
        name: "confirm_run_command",
      }),
      allow(WILDCARD, { name: "confirm_run_command" }),
    ];
  }
  return [
    deny(BuiltinTools.RUN_COMMAND, {
      name: "confirm_run_command",
    }),
    allow(WILDCARD, { name: "confirm_run_command" }),
  ];
}

export const ask_user: typeof askUser = askUser;
export const confirm_run_command: typeof confirmRunCommand = confirmRunCommand;

function normalizePath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return resolveExistingPrefix(absolutePath);
  }
}

function resolveExistingPrefix(absolutePath: string): string {
  const parsed = parse(absolutePath);
  const segments = absolutePath.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = join(current, segments[index]!);
    if (!existsSync(candidate)) {
      return join(current, ...segments.slice(index));
    }
    current = realpathSync.native(candidate);
  }

  return current;
}

function isCaseInsensitive(): boolean {
  return platform() === "darwin" || platform() === "win32";
}

export function isPathInWorkspace(targetPath: string, workspacePath: string): boolean {
  try {
    let target = normalizePath(targetPath);
    let workspace = normalizePath(workspacePath);
    if (isCaseInsensitive()) {
      target = target.toLocaleLowerCase();
      workspace = workspace.toLocaleLowerCase();
    }
    const relativePath = relative(workspace, target);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  } catch {
    return false;
  }
}

export const is_path_in_workspace: typeof isPathInWorkspace = isPathInWorkspace;

export function workspaceOnly(workspaces: Array<string | URL>): Policy[] {
  const workspaceStrings = workspaces.map((workspace) =>
    workspace instanceof URL ? fileURLToPath(workspace) : workspace,
  );
  return BuiltinTools.fileTools().map((tool) =>
    deny(tool, {
      name: "workspace_only",
      when: ((call: ToolCall) => {
        const path = call.canonicalPath ?? "";
        if (!path) {
          return false;
        }
        return !workspaceStrings.some((workspace) => isPathInWorkspace(path, workspace));
      }) as Predicate,
    }),
  );
}

export const workspace_only: typeof workspaceOnly = workspaceOnly;

const LEVEL_SPECIFIC_DENY = 0;
const LEVEL_SPECIFIC_ASK = 1;
const LEVEL_SPECIFIC_ALLOW = 2;
const LEVEL_PREFIX_DENY = 3;
const LEVEL_PREFIX_ASK = 4;
const LEVEL_PREFIX_ALLOW = 5;
const LEVEL_GLOBAL_DENY = 6;
const LEVEL_GLOBAL_ASK = 7;
const LEVEL_GLOBAL_ALLOW = 8;
const NUM_LEVELS = 9;

function bucketIndex(policy: Policy): number {
  const isGlobal = policy.tool === WILDCARD;
  const isPrefix = policy.tool.endsWith("/*");
  if (isGlobal) {
    return {
      [Decision.DENY]: LEVEL_GLOBAL_DENY,
      [Decision.ASK_USER]: LEVEL_GLOBAL_ASK,
      [Decision.APPROVE]: LEVEL_GLOBAL_ALLOW,
    }[policy.decision];
  }
  if (isPrefix) {
    return {
      [Decision.DENY]: LEVEL_PREFIX_DENY,
      [Decision.ASK_USER]: LEVEL_PREFIX_ASK,
      [Decision.APPROVE]: LEVEL_PREFIX_ALLOW,
    }[policy.decision];
  }
  return {
    [Decision.DENY]: LEVEL_SPECIFIC_DENY,
    [Decision.ASK_USER]: LEVEL_SPECIFIC_ASK,
    [Decision.APPROVE]: LEVEL_SPECIFIC_ALLOW,
  }[policy.decision];
}

function matchesTarget(policyTool: string, callTarget: string, isMcp: boolean): boolean {
  if (policyTool === WILDCARD) {
    return true;
  }
  if (isMcp) {
    if (policyTool.endsWith("/*")) {
      const policyServer = policyTool.slice(0, -2);
      const [callServer] = callTarget.split("/", 1);
      return policyServer === callServer;
    }
    return policyTool === callTarget;
  }
  return policyTool === callTarget;
}

async function evaluatePredicate(policy: Policy, toolCall: ToolCall): Promise<boolean> {
  if (!policy.when) {
    return true;
  }
  const source = policy.when.toString();
  const hasNoParameters = /^\s*(?:async\s*)?(?:function\b[^(]*\(\s*\)|\(\s*\)\s*=>)/.test(source);
  if (hasNoParameters) {
    return Boolean(await (policy.when as () => boolean | Promise<boolean>)());
  }
  const wantsToolCall =
    source.includes("ToolCall") || /^\s*(?:async\s*)?\(?\s*(?:toolCall|tc|call)\b/.test(source);
  const result = wantsToolCall
    ? await (policy.when as (toolCall: ToolCall) => boolean | Promise<boolean>)(toolCall)
    : await (policy.when as (args: Record<string, unknown>) => boolean | Promise<boolean>)(
        toolCall.args,
      );
  return Boolean(result);
}

function reprError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    const message = error.message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `${name}('${message}')`;
  }
  return String(error);
}

export class PolicyDecideHook extends PreToolCallDecideHook {
  #buckets: Policy[][];
  #serverNames: string[];

  constructor(buckets: Policy[][], serverNames: string[]) {
    super();
    this.#buckets = buckets;
    this.#serverNames = [...serverNames].sort((a, b) => b.length - a.length);
  }

  #parseMcpTool(toolName: string): [string, string] | undefined {
    if (!toolName.startsWith("mcp_")) {
      return undefined;
    }
    const rest = toolName.slice(4);
    for (const server of this.#serverNames) {
      if (rest.startsWith(`${server}_`)) {
        return [server, rest.slice(server.length + 1)];
      }
    }
    return undefined;
  }

  async #evaluatePolicy(policy: Policy, toolCall: ToolCall): Promise<HookResult | undefined> {
    const mcpInfo = this.#parseMcpTool(String(toolCall.name));
    const callTarget = mcpInfo ? `${mcpInfo[0]}/${mcpInfo[1]}` : String(toolCall.name);
    const isMcp = mcpInfo !== undefined;
    if (!matchesTarget(policy.tool, callTarget, isMcp)) {
      return undefined;
    }
    try {
      if (!(await evaluatePredicate(policy, toolCall))) {
        return undefined;
      }
      return await this.#apply(policy, toolCall);
    } catch (error) {
      return new HookResult({
        allow: false,
        message: `Policy evaluation failed for policy '${policy.name || policy.tool}': ${reprError(error)}`,
      });
    }
  }

  async run(_context: HookContext, data: ToolCall): Promise<HookResult> {
    for (const bucket of this.#buckets) {
      for (const policy of bucket) {
        const result = await this.#evaluatePolicy(policy, data);
        if (result) {
          return result;
        }
      }
    }
    return new HookResult({ allow: true });
  }

  async #apply(policy: Policy, toolCall: ToolCall): Promise<HookResult> {
    const label = policy.name || policy.tool;
    if (policy.decision === Decision.DENY) {
      return new HookResult({
        allow: false,
        message: `Denied by policy '${label}'.`,
      });
    }
    if (policy.decision === Decision.APPROVE) {
      return new HookResult({ allow: true });
    }
    if (!policy.askUser) {
      throw new Error("ASK_USER policy is missing an ask_user handler.");
    }
    const approved = await policy.askUser(toolCall);
    return approved
      ? new HookResult({ allow: true })
      : new HookResult({
          allow: false,
          message: `User denied tool '${toolCall.name}' (policy '${label}').`,
        });
  }
}

function flattenPolicies(policies: Array<Policy | Policy[]>): Policy[] {
  return policies.flatMap((policy) => {
    if (policy instanceof Policy) {
      return [policy];
    }
    if (Array.isArray(policy) && policy.every((entry) => entry instanceof Policy)) {
      return policy;
    }
    throw new Error(`Expected Policy or Policy[], got ${typeof policy}`);
  });
}

export function enforce(
  policies: Array<Policy | Policy[]>,
  options: EnforceOptions = {},
): PreToolCallDecideHook {
  const flatPolicies = flattenPolicies(policies);
  const mcpServers = options.mcpServers ?? options.mcp_servers ?? [];
  const hasMcpPolicy = flatPolicies.some(
    (policy) => policy.tool.includes("/") && policy.tool !== WILDCARD,
  );
  if (hasMcpPolicy && !mcpServers.length) {
    throw new Error(
      "MCP policies (containing '/') were detected, but mcpServers was not provided to enforce().",
    );
  }
  for (const policy of flatPolicies) {
    if (policy.decision === Decision.ASK_USER && !policy.askUser) {
      throw new Error(
        `ASK_USER policy '${policy.name || policy.tool}' is missing an ask_user handler. Provide one via policy.ask_user(tool, { handler }).`,
      );
    }
  }
  const buckets: Policy[][] = Array.from({ length: NUM_LEVELS }, () => []);
  for (const policy of flatPolicies) {
    buckets[bucketIndex(policy)]!.push(policy);
  }
  return new PolicyDecideHook(
    buckets,
    mcpServers.map((server) => server.name),
  );
}
