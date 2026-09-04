import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { InstagramHttpClient } from '../../../channel-hub/adapters/instagram/instagram.http-client';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';
import type { CommentReceivedPayload } from '../../automations.types';

interface ReplyCommentPrivateParams {
  body: string;
}

/**
 * Resposta PRIVADA a um comentario — a DM que o ManyChat vende.
 *
 * Por que esta acao existe separada do `send_message`:
 *
 * A Meta so aceita DM comum dentro da janela de 24h contada a partir da
 * ultima mensagem que o contato mandou. Quem acabou de comentar num post
 * quase nunca esta nessa janela — logo, `send_message` falharia.
 *
 * A resposta privada ao comentario e a EXCECAO prevista pela plataforma:
 * pode ser enviada uma vez por comentario, em ate 7 dias, mesmo sem janela
 * aberta. E ela propria ABRE a janela de 24h quando a pessoa responde.
 *
 * Consequencia pratica pra quem monta automacao: esta acao e a PRIMEIRA de
 * qualquer fluxo que comeca em comentario. Um `send_message` antes dela
 * bate na parede da Meta.
 */
@Injectable()
export class ReplyCommentPrivateHandler implements ActionHandler {
  private readonly logger = new Logger(ReplyCommentPrivateHandler.name);

  readonly type = 'reply_comment_private' as const;
  // Falha de comunicacao nao deve travar as acoes de estado que vem depois
  // (etiquetar, mover no pipeline) — mesmo criterio do send_message.
  readonly continueOnErrorDefault = true;

  constructor(private readonly ig: InstagramHttpClient) {}

  validateParams(params: Record<string, unknown>): void {
    if (!params.body || typeof params.body !== 'string') {
      throw new Error('reply_comment_private: "body" é obrigatório (string)');
    }
    if ((params.body as string).trim().length === 0) {
      throw new Error('reply_comment_private: "body" não pode ser vazio');
    }
    // Limite da DM do Instagram.
    if ((params.body as string).length > 1000) {
      throw new Error(
        'reply_comment_private: "body" longo demais (máx 1000 caracteres)',
      );
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as ReplyCommentPrivateParams;
    const payload = ctx.payload as CommentReceivedPayload;

    // Guarda de tipo: a acao so faz sentido em evento de comentario. Sem
    // isto, arrastar ela pra uma automacao de MESSAGE_RECEIVED produziria
    // uma chamada sem commentId e um erro cru da Meta.
    if (!payload?.commentId) {
      return {
        ok: false,
        errorCode: 'invalid_params',
        errorMessage:
          'reply_comment_private só funciona em automação com gatilho COMMENT_RECEIVED',
      };
    }

    const channel = await ctx.prisma.channel.findFirst({
      where: {
        id: payload.channelId,
        organizationId: ctx.organizationId,
        deletedAt: null,
      },
    });
    if (!channel) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: 'canal do comentário não encontrado',
      };
    }
    if (channel.type !== ChannelType.INSTAGRAM) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: `resposta privada a comentário só existe no Instagram (canal é ${channel.type})`,
      };
    }

    const text = this.render(p.body, payload);

    try {
      const result = await this.ig.sendMessage(channel, {
        // `comment_id` no lugar de `id`: e isto que diz a Meta "esta DM e a
        // resposta privada AQUELE comentario", e o que dispensa a janela.
        recipient: { comment_id: payload.commentId },
        message: { text },
      });
      this.logger.log(
        `Resposta privada enviada ao comentário ${payload.commentId} (@${payload.username ?? '?'})`,
      );
      return {
        ok: true,
        output: {
          commentId: payload.commentId,
          messageId: result?.message_id ?? null,
        },
      };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        `Resposta privada falhou para ${payload.commentId}: ${message}`,
      );
      return {
        ok: false,
        errorCode: 'external_error',
        errorMessage: message,
      };
    }
  }

  /** Variaveis simples do comentario. Sem motor de template — so o que a Meta deixa personalizar sem risco. */
  private render(body: string, payload: CommentReceivedPayload): string {
    return body
      .replace(/\{\{\s*username\s*\}\}/g, payload.username ?? '')
      .replace(/\{\{\s*texto\s*\}\}/g, payload.text ?? '')
      .trim();
  }
}
