import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { workspaceMembers, workspaces } from '../database/schema';

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(userId: string) {
    const rows = await this.database.db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.createdAt));
    return rows.map(({ workspace, role }) => this.dto(workspace, role));
  }

  async create(user: AuthenticatedUser, name: string) {
    return this.database.db.transaction(async (tx) => {
      const workspace = { id: newId('workspace'), name: name.trim(), ownerId: user.id };
      await tx.insert(workspaces).values(workspace);
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
      return this.dto(workspace, 'owner');
    });
  }

  async get(userId: string, workspaceId: string) {
    const member = await this.assertMember(userId, workspaceId);
    const workspace = await this.database.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!workspace) throw new NotFoundException('Workspace not found');
    return this.dto(workspace, member.role);
  }

  async assertMember(userId: string, workspaceId: string) {
    const member = await this.database.db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)),
    });
    if (!member) throw new ForbiddenException('Workspace access denied');
    return member;
  }

  private dto(workspace: { id: string; name: string; ownerId: string }, role: string) {
    return { workspace_id: workspace.id, name: workspace.name, role, owner_id: workspace.ownerId };
  }
}
