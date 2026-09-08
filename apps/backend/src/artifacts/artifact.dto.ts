import { IsIn, IsOptional } from 'class-validator';

export class ArtifactContentQueryDto {
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}
