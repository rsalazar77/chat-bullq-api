import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramOutboundAdapter } from './instagram.outbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';
import { InstagramSyncAdapter } from './instagram.sync-adapter';
import { InstagramContactEnricherService } from './instagram-contact-enricher.service';
import { InstagramOAuthService } from './instagram-oauth.service';

@Module({
  // JwtModule: o OAuth assina/valida o `state` do redirect.
  imports: [JwtModule.register({})],
  providers: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramMessageMapper,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
    InstagramOAuthService,
  ],
  exports: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
    InstagramOAuthService,
  ],
})
export class InstagramModule {}
