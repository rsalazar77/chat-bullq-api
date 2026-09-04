import { Prisma, PrismaClient } from '@prisma/client';
import { AutomationEventPayload } from '../automations.types';
import { OutboxService } from '../outbox/outbox.service';

// All fully supported action types in the engine. UI consumes this via
// the /meta endpoint to render the picker. Adding a new action = add a
// type here + register a handler.
export const ACTION_TYPES = [
  'add_tag',
  'remove_tag',
  'add_to_pipeline',
  'move_pipeline_stage',
  'assign_user',
  'send_message',
  // Resposta privada a comentario do Instagram. Unica acao capaz de mandar
  // DM sem janela de 24h aberta — ver o handler pro porque.
  'reply_comment_private',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionDefinition {
  type: ActionType;
  // Free-form params per action type. Schema is action-specific and
  // validated at save-time by each handler's `validateParams` plus by
  // the worker pre-flight (target entities exist, belong to org, etc.).
  params: Record<string, unknown>;
  // continueOnError per action. Defaults applied at save:
  //   • communication actions (send_message): true
  //   • state-changing actions (everything else): false
  continueOnError?: boolean;
}

// Context handed to each action handler. Carries everything the handler
// needs without having to re-fetch from the DB. Critically also carries
// the trace metadata so emitted cascade events keep the chain tied
// together for loop detection + run history queries.
export interface ActionContext {
  organizationId: string;
  payload: AutomationEventPayload;
  traceId: string;
  cascadeDepth: number; // already incremented relative to original event
  visitedAutomations: string[];
  outbox: OutboxService;
  prisma: PrismaClient;
  actorId: string; // automation creator (snapshot)
}

export interface ActionExecutionResult {
  ok: boolean;
  // Short, machine-readable error code for UI grouping. Examples:
  //   invalid_params | invalid_ref | conflict | external_error | timeout
  errorCode?: string;
  errorMessage?: string;
  // Free-form output used by tests/debug/run-log. Avoid putting anything
  // sensitive here — it gets persisted in `automation_runs.actions_log`.
  output?: Record<string, unknown>;
}

export interface ActionHandler {
  readonly type: ActionType;
  // Default for `continueOnError` when the user didn't set it explicitly.
  readonly continueOnErrorDefault: boolean;

  // Validate at save time (CRUD endpoint calls this). Throw with a clear
  // message — the controller turns it into a 400.
  validateParams(params: Record<string, unknown>): void;

  // Execute. MUST be idempotent enough that a retry doesn't cause a
  // second observable mutation (e.g. add_tag dedups via @@unique).
  execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult>;
}

// Helper — used by controllers + tests
export function isActionType(value: unknown): value is ActionType {
  return (
    typeof value === 'string' &&
    (ACTION_TYPES as readonly string[]).includes(value)
  );
}

// Action log entry persisted in AutomationRun.actionsLog
export interface ActionLogEntry {
  index: number;
  type: ActionType;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  output?: Record<string, unknown>;
}

// Re-exported for handlers — they need Prisma's TX type to optionally run
// inside a transaction when emitting cascade events.
export type { Prisma };
