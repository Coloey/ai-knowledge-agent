import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { LlmService } from './llm.service';
import { RetrievalService } from './retrieval.service';
import { SessionControlService } from './session-control.service';
import { SessionEventJournalModule } from './session-event-journal.module';
import { SessionRateLimitGuard } from './session-rate-limit.guard';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AuthModule, WorkspacesModule, AiModule, SessionEventJournalModule],
  controllers: [SessionsController],
  providers: [SessionsService, RetrievalService, LlmService, SessionControlService, SessionRateLimitGuard],
})
export class SessionsModule {}
