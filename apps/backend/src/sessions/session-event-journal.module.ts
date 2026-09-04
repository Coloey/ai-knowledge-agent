import { Module } from '@nestjs/common';

import { SessionEventJournal } from './session-event-journal.service';

@Module({
  providers: [SessionEventJournal],
  exports: [SessionEventJournal],
})
export class SessionEventJournalModule {}
