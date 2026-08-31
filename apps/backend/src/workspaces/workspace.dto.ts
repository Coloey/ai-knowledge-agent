import { IsString, Length } from 'class-validator';

export class CreateWorkspaceRequestDto {
  @IsString()
  @Length(1, 120)
  name!: string;
}
