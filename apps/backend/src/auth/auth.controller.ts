import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';

import { ok } from '../common/api-response';
import { AuthService } from './auth.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import type { AuthenticatedUser } from './auth.types';
import { LoginRequestDto, LogoutRequestDto, RefreshRequestDto, RegisterRequestDto } from './auth.dto';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  async register(@Body() input: RegisterRequestDto) {
    return ok(await this.auth.register(input));
  }

  @Post('login')
  @UseGuards(AuthRateLimitGuard)
  async login(@Body() input: LoginRequestDto) {
    return ok(await this.auth.login(input));
  }

  @Post('refresh')
  @UseGuards(AuthRateLimitGuard)
  async refresh(@Body() input: RefreshRequestDto) {
    return ok(await this.auth.refresh(input.refresh_token));
  }

  @Post('logout')
  async logout(@Body() input: LogoutRequestDto) {
    await this.auth.logout(input.refresh_token);
    return ok({ revoked: true });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return ok({ uid: user.id, email: user.email, name: user.name, avatar: user.avatar });
  }
}
