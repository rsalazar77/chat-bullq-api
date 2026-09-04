import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Response } from 'express';
import { ChannelType, OrgRole } from '@prisma/client';
import { InstagramOAuthService } from './instagram-oauth.service';
import { ChannelsService } from '../../channels/channels.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../../common/guards';
import { CurrentOrg, CurrentUser, Roles, Public } from '../../../../common/decorators';

/**
 * Conexão automática do canal INSTAGRAM.
 *
 * Duas rotas com posturas de segurança opostas de propósito:
 *  - /start    é autenticada e restrita a OWNER/ADMIN — é ela que decide,
 *              a partir do JWT de quem clicou, em qual organização o canal
 *              vai nascer, e sela essa decisão dentro do `state` assinado.
 *  - /callback é pública por necessidade (quem chega é o navegador vindo da
 *              Meta, sem Authorization header) e por isso NÃO confia em nada
 *              que venha na query além do `state` assinado por nós.
 */
@ApiTags('Channels')
@Controller('channels/instagram/oauth')
export class InstagramOAuthController {
  private readonly logger = new Logger(InstagramOAuthController.name);

  constructor(
    private readonly oauth: InstagramOAuthService,
    private readonly channels: ChannelsService,
  ) {}

  @Get('start')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary: 'Devolve a URL do diálogo de autorização do Instagram',
  })
  start(
    @CurrentOrg() org: { id: string; userOrganizationId: string },
    @CurrentUser() user: { id: string },
  ) {
    const url = this.oauth.buildAuthorizeUrl({
      organizationId: org.id,
      userOrganizationId: org.userOrganizationId,
      userId: user.id,
    });
    return { url };
  }

  @Get('callback')
  @Public()
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    // Usuário cancelou no diálogo da Meta — não é falha nossa.
    if (error) {
      this.logger.warn(`OAuth negado pelo usuário: ${error}`);
      return res.redirect(
        this.oauth.frontendRedirect('erro', errorDescription || error),
      );
    }

    try {
      if (!code || !state) {
        throw new BadRequestException('code ou state ausente');
      }

      // O state é a ÚNICA fonte de verdade sobre a organização de destino.
      const ctx = this.oauth.verifyState(state);
      const profile = await this.oauth.exchangeCode(code);

      // Sem inscrição nos webhooks o canal nasce mudo. Falha aqui aborta a
      // criação em vez de deixar um canal que parece certo e não recebe nada.
      await this.oauth.subscribeToWebhooks(
        profile.igUserId,
        profile.accessToken,
      );

      const existing = await this.channels.findByInstagramUserId(
        ctx.organizationId,
        profile.igUserId,
      );

      if (existing) {
        // Reconexão: token novo por cima do canal que já existe, preservando
        // conversas, grants de acesso e histórico.
        await this.channels.update(existing.id, ctx.organizationId, {
          config: {
            ...((existing.config as Record<string, any>) ?? {}),
            igBusinessId: profile.igBusinessId,
            igUserId: profile.igUserId,
            username: profile.username,
            accessToken: profile.accessToken,
            tokenExpiresAt: profile.tokenExpiresAt,
          },
        });
        this.logger.log(
          `Canal INSTAGRAM reconectado: @${profile.username} (org ${ctx.organizationId})`,
        );
      } else {
        await this.channels.create(
          ctx.organizationId,
          {
            type: ChannelType.INSTAGRAM,
            name: `Instagram @${profile.username}`,
            config: {
              igBusinessId: profile.igBusinessId,
              igUserId: profile.igUserId,
              username: profile.username,
              accessToken: profile.accessToken,
              appSecret: process.env.INSTAGRAM_APP_SECRET,
              tokenExpiresAt: profile.tokenExpiresAt,
            },
          },
          {
            userOrganizationId: ctx.userOrganizationId,
            role: OrgRole.OWNER,
          },
        );
        this.logger.log(
          `Canal INSTAGRAM criado: @${profile.username} (org ${ctx.organizationId})`,
        );
      }

      return res.redirect(this.oauth.frontendRedirect('ok'));
    } catch (err: any) {
      this.logger.error(`Callback do Instagram falhou: ${err.message}`);
      return res.redirect(this.oauth.frontendRedirect('erro', err.message));
    }
  }
}
