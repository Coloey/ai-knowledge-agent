import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { StorageModule } from '../storage/storage.module';
import { LibraryParserService } from './library-parser.service';
import { TikaClientService } from './tika-client.service';

@Module({
  imports: [AiModule, StorageModule],
  providers: [LibraryParserService, TikaClientService],
  exports: [LibraryParserService, StorageModule],
})
export class LibraryCoreModule {}
