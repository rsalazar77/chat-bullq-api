import { Injectable, Logger } from '@nestjs/common';
import { AutomationTrigger, Channel, ChannelType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from '../automations/outbox/outbox.service';
import { ContactResolverService } from '../messaging/pipeline/contact-resolver.service';
import type { NormalizedComment } from './ports/types';

/**
 * Comentario → evento de automacao.
 *
 * Diferente de mensagem, comentario NAO cria conversa. Quem comenta pode
 * nunca ter mandado DM, e criar uma conversa vazia por comentario encheria
 * a caixa de entrada de ruido que ninguem vai atender. A conversa nasce
 * depois, se e quando a automacao responder no privado — aí a resposta
 * entra pelo caminho normal de mensagem.
 *
 * O contato, esse sim, é criado: ele é a chave de bloqueio do outbox e o
 * alvo de qualquer acao subsequente (etiqueta, pipeline, DM).
 */
@Injectable()
export class CommentEventService {
  private readonly logger = new Logger(CommentEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly contactResolver: ContactResolverService,
  ) {}

  async handle(channel: Channel, comment: NormalizedComment): Promise<void> {
    // Eco do proprio perfil: a Meta entrega no mesmo webhook os comentarios
    // que a conta faz. Responder a si mesma dispararia laco.
    const config = (channel.config ?? {}) as Record<string, any>;
    const selfIds = [config.igUserId, config.igBusinessId]
      .filter(Boolean)
      .map(String);
    if (selfIds.includes(comment.externalContactId)) {
      this.logger.debug(`Comentario proprio ignorado: ${comment.externalCommentId}`);
      return;
    }

    // Reusa o resolver do inbound: mesmo fast-path, mesmo lock por
    // (channel, externalId), mesma tabela. Um comentarista que depois manda
    // DM cai no MESMO contato, porque a chave externa é o IG user id nos
    // dois caminhos.
    const contact = await this.contactResolver.resolve(
      channel.organizationId,
      channel.id,
      {
        externalContactId: comment.externalContactId,
        contactName: comment.username ?? undefined,
        channelType: ChannelType.INSTAGRAM,
        externalMessageId: comment.externalCommentId,
        timestamp: comment.timestamp,
        type: 'TEXT',
        content: { text: comment.text },
        rawPayload: comment.rawPayload,
      } as any,
    );

    await this.outbox.enqueue(
      this.prisma,
      AutomationTrigger.COMMENT_RECEIVED,
      {
        organizationId: channel.organizationId,
        contactId: contact.contactId,
        channelId: channel.id,
        commentId: comment.externalCommentId,
        mediaId: comment.mediaId,
        text: comment.text,
        username: comment.username,
        isReply: comment.isReply,
      },
    );

    this.logger.log(
      `COMMENT_RECEIVED enfileirado: @${comment.username ?? '?'} em ${comment.mediaId ?? 'midia desconhecida'}`,
    );
  }
}
