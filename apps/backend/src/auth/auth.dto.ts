import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class RegisterRequestDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @Length(1, 120)
  name = 'User';
}

export class LoginRequestDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshRequestDto {
  @IsString()
  refresh_token!: string;
}

export class LogoutRequestDto extends RefreshRequestDto {}
