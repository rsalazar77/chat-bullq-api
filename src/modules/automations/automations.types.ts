import { AutomationTrigger } from '@prisma/client';

// ─── Event payloads ──────────────────────────────────────────────────
//
// Every domain event written to the outbox carries a strongly-typed
// payload. Workers/conditions/actions consume these — adding a field here
// without updating the conditions registry will produce a "field not
// recognized" error at save time, never silent corruption.
//
// Convention: every payload includes the entities the action layer can
// possibly mutate (contactId, conversationId, channelId). Even when the
// trigger doesn't need them, populating them keeps action handlers simple.

export interface BaseEventPayload {
  organizationId: string;
  // contactId is the lock key — every event MUST resolve to a contact for
  // the per-lead serialization to work. The outbox service refuses to
  // enqueue events without one.
  contactId: string;
  conversationId?: string;
  channelId?: string;
  actorId?: string;
}

export interface TagAddedPayload extends BaseEventPayload {
  tagId: string;
  // Where the tag landed — `conversation` (ConversationTag) or `contact`
  // (ContactTag). Conditions can filter on this so an automation only fires
  // for one or the other.
  target: 'conversation' | 'contact';
}

export interface TagRemovedPayload extends BaseEventPayload {
  tagId: string;
  target: 'conversation' | 'contact';
}

export interface MessageReceivedPayload extends BaseEventPayload {
  conversationId: string;
  channelId: string;
  messageId: string;
  // body is denormalized here because conditions match on it directly —
  // worker shouldn't have to round-trip to the DB just to check
  // "contains foo".
  body: string | null;
  type: string; // MessageContentType — kept loose to avoid Prisma circular dep
  hasAttachment: boolean;
  isFromCustomer: true; // INBOUND only — outbound never enters this trigger
}

export interface ConversationStatusChangedPayload extends BaseEventPayload {
  conversationId: string;
  channelId: string;
  fromStatus: string;
  toStatus: string;
}

export interface ConversationAssignedPayload extends BaseEventPayload {
  conversationId: string;
  channelId: string;
  fromAssigneeId: string | null;
  toAssigneeId: string;
}

export interface CommentReceivedPayload extends BaseEventPayload {
  channelId: string;
  // id do comentario no provedor — chave de deduplicacao e alvo da
  // resposta publica/privada.
  commentId: string;
  mediaId: string | null;
  text: string;
  // username de quem comentou, util em condicao e em variavel de resposta.
  username: string | null;
  // Resposta a outro comentario (thread) em vez de comentario raiz.
  isReply: boolean;
}

export type AutomationEventPayload =
  | TagAddedPayload
  | TagRemovedPayload
  | MessageReceivedPayload
  | ConversationStatusChangedPayload
  | ConversationAssignedPayload
  | CommentReceivedPayload;

// Discriminated union by trigger — used by the listener factory and by
// tests to construct events with the correct payload shape.
export type TriggerToPayload = {
  [AutomationTrigger.TAG_ADDED]: TagAddedPayload;
  [AutomationTrigger.TAG_REMOVED]: TagRemovedPayload;
  [AutomationTrigger.MESSAGE_RECEIVED]: MessageReceivedPayload;
  [AutomationTrigger.CONVERSATION_STATUS_CHANGED]: ConversationStatusChangedPayload;
  [AutomationTrigger.CONVERSATION_ASSIGNED]: ConversationAssignedPayload;
  [AutomationTrigger.COMMENT_RECEIVED]: CommentReceivedPayload;
};

// ─── BullMQ job shape ────────────────────────────────────────────────

export interface AutomationJobData {
  outboxEventId: string;
  organizationId: string;
  trigger: AutomationTrigger;
  payload: AutomationEventPayload;
  traceId: string;
  cascadeDepth: number;
  // visitedAutomations carries the loop-detection set across cascade
  // hops. Each action that re-emits an event MUST forward this list with
  // its own automationId appended. Encoded as array (not Set) so it
  // serializes through Redis cleanly.
  visitedAutomations: string[];
}
