import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class SendMessageRequestDto {
  @IsOptional()
  @IsString()
  session_id?: string;

  @IsOptional()
  @IsString()
  request_id?: string;

  @IsString()
  workspace_id!: string;

  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsInt()
  timezone_offset = 0;

  @IsOptional()
  @IsString()
  display_language = 'zh-CN';

  @IsOptional()
  @IsObject()
  options: Record<string, unknown> = {};
}

export class InterruptRequestDto {
  @IsString()
  workspace_id!: string;

  @IsString()
  session_id!: string;
}

export class SessionDetailRequestDto extends InterruptRequestDto {}

export class RateAnswerRequestDto extends InterruptRequestDto {
  @IsString()
  answer_id!: string;

  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(1)
  rating?: number | null;
}

export class SessionHistoryRequestDto {
  @IsString()
  workspace_id!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size = 20;
}
