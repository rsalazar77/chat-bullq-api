import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import {
  CurrentChannelAccess,
  CurrentOrg,
  CurrentUser,
  Roles,
} from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ChannelAccessService } from './channel-access.service';
import type { ChannelAccess } from './channel-access.service';
import { SetMemberChannelsDto } from './dto/set-member-channels.dto';

@ApiTags('Channel Access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations/members')
export class MemberChannelsController {
  constructor(
    private readonly service: ChannelAccessService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get(':memberId/channels')
  @ApiOperation({
    summary:
      'List the channel grants a member has, limited to the channels the caller can see.',
  })
  list(
    @CurrentOrg('id') orgId: string,
    @Param('memberId') memberId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.listMemberChannels(orgId, memberId, access);
  }

  @Put(':memberId/channels')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary:
      'Replace the channels a member can access, within the caller own scope. Grants on channels the caller cannot see are left untouched.',
  })
  async set(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') actorId: string,
    @Param('memberId') memberId: string,
    @Body() dto: SetMemberChannelsDto,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    const result = await this.service.setMemberChannels(
      orgId,
      memberId,
      dto.channelIds,
      actorId,
      access,
    );
    await Promise.all([
      ...result.added.map((channelId) =>
        this.realtime.grantChannelToUser(result.userId, channelId),
      ),
      ...result.removed.map((channelId) =>
        this.realtime.revokeChannelFromUser(result.userId, channelId),
      ),
    ]);
    return { added: result.added, removed: result.removed };
  }
}
