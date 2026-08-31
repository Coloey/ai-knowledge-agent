import { createHash, randomBytes } from 'node:crypto';

import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { authRefreshTokens, users, workspaceMembers, workspaces } from '../database/schema';
import type { AuthenticatedUser } from './auth.types';
import type { LoginRequestDto, RegisterRequestDto } from './auth.dto';
import { PasswordService } from './password.service';

export interface AuthPayload {
  access_token: string;
  refresh_token: string;
  user: { uid: string; email: string; name: string; avatar: string };
  default_workspace_id: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
  ) {}

  async register(input: RegisterRequestDto): Promise<AuthPayload> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.database.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await this.passwords.hash(input.password);
    return this.database.db.transaction(async (tx) => {
      const user = { id: newId('user'), email, passwordHash, name: input.name.trim(), avatar: '' };
      const workspace = { id: newId('workspace'), name: `${user.name}'s Workspace`, ownerId: user.id };
      await tx.insert(users).values(user);
      await tx.insert(workspaces).values(workspace);
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
      const tokens = await this.issueTokens(tx, user.id);
      return { ...tokens, user: this.userDto(user), default_workspace_id: workspace.id };
    });
  }

  async login(input: LoginRequestDto): Promise<AuthPayload> {
    const email = input.email.trim().toLowerCase();
    const user = await this.database.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user || !(await this.passwords.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.database.db
        .update(users)
        .set({ passwordHash: await this.passwords.hash(input.password), updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    const member = await this.database.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(asc(workspaceMembers.createdAt))
      .limit(1);
    const tokens = await this.issueTokens(this.database.db, user.id);
    return { ...tokens, user: this.userDto(user), default_workspace_id: member[0]?.workspaceId || '' };
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const rotated = await this.database.db.transaction(async (tx) => {
      const records = await tx
        .select()
        .from(authRefreshTokens)
        .where(eq(authRefreshTokens.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      const current = records[0];
      if (!current) return null;

      if (current.revokedAt) {
        await tx
          .update(authRefreshTokens)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(authRefreshTokens.familyId, current.familyId), isNull(authRefreshTokens.revokedAt)));
        return { invalid: true } as const;
      }
      if (current.expiresAt <= new Date()) return { invalid: true } as const;

      const tokens = await this.issueTokens(tx, current.userId, current.familyId);
      const replacement = await tx.query.authRefreshTokens.findFirst({
        where: eq(authRefreshTokens.tokenHash, this.hashToken(tokens.refresh_token)),
      });
      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: new Date(), replacedById: replacement?.id, updatedAt: new Date() })
        .where(eq(authRefreshTokens.id, current.id));
      return { invalid: false, tokens: this.withExpiry(tokens) } as const;
    });
    if (rotated?.invalid) throw new UnauthorizedException('Refresh token has expired or already been used');
    if (rotated) return rotated.tokens;

    // One-time bridge for refresh JWTs issued by the legacy FastAPI backend.
    let legacyPayload: { sub?: string; typ?: string; exp?: number };
    try {
      legacyPayload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get('JWT_SECRET_KEY', { infer: true }),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (legacyPayload.typ !== 'refresh' || !legacyPayload.sub || !legacyPayload.exp) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.database.db.query.users.findFirst({ where: eq(users.id, legacyPayload.sub) });
    if (!user) throw new UnauthorizedException('User not found');

    return this.database.db.transaction(async (tx) => {
      const consumed = await tx.query.authRefreshTokens.findFirst({
        where: eq(authRefreshTokens.tokenHash, tokenHash),
      });
      if (consumed) throw new UnauthorizedException('Refresh token has already been used');
      const familyId = newId('rtf');
      const tokens = await this.issueTokens(tx, user.id, familyId);
      const replacement = await tx.query.authRefreshTokens.findFirst({
        where: eq(authRefreshTokens.tokenHash, this.hashToken(tokens.refresh_token)),
      });
      await tx.insert(authRefreshTokens).values({
        id: newId('rt'),
        userId: user.id,
        familyId,
        tokenHash,
        expiresAt: new Date(legacyPayload.exp! * 1_000),
        revokedAt: new Date(),
        replacedById: replacement?.id,
      });
      return this.withExpiry(tokens);
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.database.db
      .update(authRefreshTokens)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(authRefreshTokens.tokenHash, this.hashToken(refreshToken)), isNull(authRefreshTokens.revokedAt)));
  }

  private async issueTokens(
    database: Pick<typeof this.database.db, 'insert'>,
    userId: string,
    familyId = newId('rtf'),
  ): Promise<{ access_token: string; refresh_token: string }> {
    const accessMinutes = this.config.get('JWT_ACCESS_TOKEN_EXPIRE_MINUTES', { infer: true });
    const refreshDays = this.config.get('JWT_REFRESH_TOKEN_EXPIRE_DAYS', { infer: true });
    const refreshToken = randomBytes(48).toString('base64url');
    await database.insert(authRefreshTokens).values({
      id: newId('rt'),
      userId,
      familyId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
    });
    const accessToken = await this.jwt.signAsync(
      { sub: userId, typ: 'access' },
      { secret: this.config.get('JWT_SECRET_KEY', { infer: true }), expiresIn: accessMinutes * 60 },
    );
    return { access_token: accessToken, refresh_token: refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private withExpiry(tokens: { access_token: string; refresh_token: string }) {
    return {
      ...tokens,
      expires_in: this.config.get('JWT_ACCESS_TOKEN_EXPIRE_MINUTES', { infer: true }) * 60,
    };
  }

  private userDto(user: Pick<AuthenticatedUser, 'email' | 'name' | 'avatar'> & { id: string }) {
    return { uid: user.id, email: user.email, name: user.name, avatar: user.avatar };
  }
}
