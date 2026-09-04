import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Channel } from '@prisma/client';
import axios from 'axios';

/**
 * OAuth do canal INSTAGRAM — "Instagram API com Instagram Login".
 *
 * É o fluxo direto (graph.instagram.com), sem Página do Facebook no meio,
 * coerente com o que o InstagramHttpClient já fala. O operador clica em
 * "Conectar com Instagram", autoriza no diálogo da Meta e o canal nasce
 * pronto — em vez de colar accessToken/appSecret/igBusinessId à mão.
 *
 * Env necessário:
 * - INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET  (app na Meta, produto Instagram)
 * - INSTAGRAM_OAUTH_REDIRECT_URI             (idêntico ao cadastrado na Meta)
 * - APP_URL                                  (pra onde devolver o navegador)
 */
@Injectable()
export class InstagramOAuthService {
  private readonly logger = new Logger(InstagramOAuthService.name);

  private static readonly AUTHORIZE_URL =
    'https://www.instagram.com/oauth/authorize';
  private static readonly TOKEN_URL =
    'https://api.instagram.com/oauth/access_token';
  private static readonly GRAPH_URL = 'https://graph.instagram.com';
  private static readonly API_VERSION = 'v21.0';

  /**
   * `instagram_business_manage_messages` é a que exige App Review. Não pedir
   * escopo a mais: permissão sem demonstração no vídeo é motivo de reprovação.
   */
  private static readonly SCOPES = [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    // Necessario pro gatilho "comentario vira DM": sem este escopo a Meta
    // aceita a assinatura do campo `comments` mas nunca entrega o evento.
    'instagram_business_manage_comments',
  ];

  /** Janela curta de propósito: o state só precisa sobreviver ao redirect. */
  private static readonly STATE_TTL = '10m';

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  isConfigured(): boolean {
    return !!(
      this.config.get('INSTAGRAM_APP_ID') &&
      this.config.get('INSTAGRAM_APP_SECRET') &&
      this.config.get('INSTAGRAM_OAUTH_REDIRECT_URI')
    );
  }

  /**
   * URL do diálogo de autorização.
   *
   * O `state` é um JWT assinado carregando a organização de destino. Sem isso
   * o callback — que é público por necessidade, já que quem chega nele é o
   * navegador vindo da Meta, sem Authorization header — aceitaria pendurar um
   * canal em qualquer organização que o atacante escolhesse.
   */
  buildAuthorizeUrl(ctx: {
    organizationId: string;
    userOrganizationId: string;
    userId: string;
  }): string {
    this.assertConfigured();

    const state = this.jwt.sign(
      {
        orgId: ctx.organizationId,
        uoId: ctx.userOrganizationId,
        sub: ctx.userId,
        purpose: 'ig_oauth',
      },
      {
        secret: this.stateSecret(),
        expiresIn: InstagramOAuthService.STATE_TTL,
      },
    );

    const params = new URLSearchParams({
      client_id: this.config.get<string>('INSTAGRAM_APP_ID')!,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: InstagramOAuthService.SCOPES.join(','),
      state,
    });

    return `${InstagramOAuthService.AUTHORIZE_URL}?${params.toString()}`;
  }

  verifyState(state: string): {
    organizationId: string;
    userOrganizationId: string;
    userId: string;
  } {
    let payload: any;
    try {
      payload = this.jwt.verify(state, { secret: this.stateSecret() });
    } catch {
      throw new UnauthorizedException('state inválido ou expirado');
    }
    if (payload?.purpose !== 'ig_oauth') {
      throw new UnauthorizedException('state de outro fluxo');
    }
    return {
      organizationId: payload.orgId,
      userOrganizationId: payload.uoId,
      userId: payload.sub,
    };
  }

  /**
   * Troca o `code` do callback por um token de longa duração (60 dias) e
   * resolve o perfil. Devolve o `config` pronto pro Channel.
   */
  async exchangeCode(code: string): Promise<{
    igBusinessId: string;
    igUserId: string;
    username: string;
    accessToken: string;
    tokenExpiresAt: string;
  }> {
    this.assertConfigured();

    // 1. code → token curto (1h)
    const form = new URLSearchParams({
      client_id: this.config.get<string>('INSTAGRAM_APP_ID')!,
      client_secret: this.config.get<string>('INSTAGRAM_APP_SECRET')!,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
      code,
    });

    let shortToken: string;
    let userId: string;
    try {
      const { data } = await axios.post(
        InstagramOAuthService.TOKEN_URL,
        form.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );
      // O fluxo novo (Instagram Login) responde { data: [ { access_token,
      // user_id, permissions } ] }; o antigo responde na raiz. Ler só a raiz
      // dava `undefined` silencioso, o axios omitia o parametro e a Meta
      // respondia "Unsupported request" — erro de rota mascarando erro de
      // leitura. Aceita as duas formas.
      const payload = Array.isArray(data?.data) ? data.data[0] : data;
      shortToken = payload?.access_token;
      userId = String(payload?.user_id ?? '');
      if (!shortToken) {
        throw new BadRequestException(
          `Meta nao devolveu access_token: ${JSON.stringify(data).slice(0, 300)}`,
        );
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Troca do code falhou: ${this.metaError(err)}`,
      );
    }

    // 2. token curto → token longo (60 dias)
    let longLived: any;
    try {
      ({ data: longLived } = await axios.get(
        // SEM prefixo de versao, de proposito: `/v21.0/access_token` nao
        // existe e a Meta responde "Unsupported request - method type: get".
        // Os endpoints de token do Instagram Login sao os unicos nao
        // versionados; o resto do graph.instagram.com exige versao.
        `${InstagramOAuthService.GRAPH_URL}/access_token`,
        {
          params: {
            grant_type: 'ig_exchange_token',
            client_secret: this.config.get<string>('INSTAGRAM_APP_SECRET'),
            access_token: shortToken,
          },
          timeout: 15_000,
        },
      ));
    } catch (err: any) {
      throw new BadRequestException(
        `Troca por token de longa duração falhou: ${this.metaError(err)}`,
      );
    }

    const accessToken: string = longLived.access_token;
    const expiresIn: number = longLived.expires_in ?? 60 * 24 * 3600;

    // 3. perfil — `user_id` aqui é o ID que os webhooks usam em `entry[].id`,
    //    que é o que o inbound adapter casa contra config.igBusinessId.
    const profile = await this.fetchProfile(accessToken);

    return {
      igBusinessId: profile.userId || userId,
      igUserId: profile.userId || userId,
      username: profile.username,
      accessToken,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async fetchProfile(
    accessToken: string,
  ): Promise<{ userId: string; username: string }> {
    try {
      const { data } = await axios.get(
        `${InstagramOAuthService.GRAPH_URL}/${InstagramOAuthService.API_VERSION}/me`,
        {
          params: { fields: 'user_id,username', access_token: accessToken },
          timeout: 15_000,
        },
      );
      return {
        userId: String(data.user_id ?? data.id ?? ''),
        username: data.username ?? '',
      };
    } catch (err: any) {
      throw new BadRequestException(
        `Leitura do perfil falhou: ${this.metaError(err)}`,
      );
    }
  }

  /**
   * Inscreve o app nos webhooks da conta. Sem isto o canal existe mas nunca
   * recebe mensagem — falha silenciosa clássica, então o erro sobe.
   */
  async subscribeToWebhooks(
    igUserId: string,
    accessToken: string,
  ): Promise<void> {
    try {
      await axios.post(
        `${InstagramOAuthService.GRAPH_URL}/${InstagramOAuthService.API_VERSION}/${igUserId}/subscribed_apps`,
        null,
        {
          params: {
            subscribed_fields: 'comments,messages',
            access_token: accessToken,
          },
          timeout: 15_000,
        },
      );
    } catch (err: any) {
      throw new BadRequestException(
        `Assinatura dos webhooks falhou: ${this.metaError(err)}`,
      );
    }
    this.logger.log(`Webhooks assinados para IG ${igUserId}`);
  }

  /**
   * Renova o token de 60 dias. A Meta só aceita renovar tokens com mais de
   * 24h de vida e que ainda não expiraram — token vencido exige reconexão
   * manual pelo diálogo, não há como recuperar pelo servidor.
   */
  async refreshLongLivedToken(channel: Channel): Promise<{
    accessToken: string;
    tokenExpiresAt: string;
  }> {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    if (!cfg.accessToken) {
      throw new BadRequestException(
        `Canal INSTAGRAM ${channel.id} sem accessToken em config`,
      );
    }

    const { data } = await axios.get(
      // Nao versionado, mesmo motivo do /access_token acima.
      `${InstagramOAuthService.GRAPH_URL}/refresh_access_token`,
      {
        params: {
          grant_type: 'ig_refresh_token',
          access_token: cfg.accessToken,
        },
        timeout: 15_000,
      },
    );

    const expiresIn: number = data.expires_in ?? 60 * 24 * 3600;
    return {
      accessToken: data.access_token,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  /** Para onde devolver o navegador depois do callback. */
  frontendRedirect(status: 'ok' | 'erro', detail?: string): string {
    const base = this.config.get<string>('APP_URL') || '';
    const params = new URLSearchParams({ ig: status });
    if (detail) params.set('motivo', detail.slice(0, 200));
    return `${base}/settings/channels?${params.toString()}`;
  }

  /**
   * A Meta responde erro em formatos diferentes conforme o endpoint
   * (`error_message` no oauth, `error.message` no graph). Sem normalizar,
   * o axios entrega só "Request failed with status code 400" e o motivo
   * real se perde.
   */
  private metaError(err: any): string {
    const data = err?.response?.data;
    const detail =
      data?.error_message ||
      data?.error?.message ||
      (typeof data === 'string' ? data : null) ||
      (data ? JSON.stringify(data) : null) ||
      err?.message ||
      'erro desconhecido';
    this.logger.error(
      `Meta respondeu ${err?.response?.status ?? '?'}: ${typeof data === 'object' ? JSON.stringify(data) : detail}`,
    );
    return detail;
  }

  private redirectUri(): string {
    return this.config.get<string>('INSTAGRAM_OAUTH_REDIRECT_URI')!;
  }

  /** Reusa o segredo do JWT da aplicação — o state é efêmero e interno. */
  private stateSecret(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'OAuth do Instagram não configurado — faltam INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET ou INSTAGRAM_OAUTH_REDIRECT_URI',
      );
    }
  }
}
