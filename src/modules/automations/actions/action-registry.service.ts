import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActionHandler, ActionType } from './action.types';
import { AddTagHandler } from './handlers/add-tag.handler';
import { RemoveTagHandler } from './handlers/remove-tag.handler';
import { AddToPipelineHandler } from './handlers/add-to-pipeline.handler';
import { MovePipelineStageHandler } from './handlers/move-pipeline-stage.handler';
import { AssignUserHandler } from './handlers/assign-user.handler';
import { SendMessageHandler } from './handlers/send-message.handler';
import { ReplyCommentPrivateHandler } from './handlers/reply-comment-private.handler';

// Centralized lookup so the executor doesn't need to know about specific
// handler classes — it just asks the registry for "the handler for type X".
// Same pattern channel-hub uses for adapters.
@Injectable()
export class ActionRegistryService implements OnModuleInit {
  private readonly handlers = new Map<ActionType, ActionHandler>();

  constructor(
    private readonly addTag: AddTagHandler,
    private readonly removeTag: RemoveTagHandler,
    private readonly addToPipeline: AddToPipelineHandler,
    private readonly movePipelineStage: MovePipelineStageHandler,
    private readonly assignUser: AssignUserHandler,
    private readonly sendMessage: SendMessageHandler,
    private readonly replyCommentPrivate: ReplyCommentPrivateHandler,
  ) {}

  onModuleInit() {
    for (const handler of [
      this.addTag,
      this.removeTag,
      this.addToPipeline,
      this.movePipelineStage,
      this.assignUser,
      this.sendMessage,
      this.replyCommentPrivate,
    ]) {
      this.handlers.set(handler.type, handler);
    }
  }

  get(type: ActionType): ActionHandler | undefined {
    return this.handlers.get(type);
  }

  all(): ActionHandler[] {
    return [...this.handlers.values()];
  }
}
