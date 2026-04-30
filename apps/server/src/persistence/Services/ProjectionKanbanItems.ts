import {
  IsoDateTime,
  KanbanItemAssignee,
  KanbanItemId,
  KanbanItemNote,
  KanbanItemPromptStatus,
  KanbanItemPullRequestLink,
  KanbanItemStatus,
  ProjectId,
} from "contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionKanbanItem = Schema.Struct({
  itemId: KanbanItemId,
  projectId: ProjectId,
  pullRequest: Schema.NullOr(KanbanItemPullRequestLink),
  title: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  generatedPrompt: Schema.NullOr(Schema.String),
  promptStatus: KanbanItemPromptStatus,
  promptError: Schema.NullOr(Schema.String),
  status: KanbanItemStatus,
  sortKey: Schema.String,
  blockedReason: Schema.NullOr(Schema.String),
  assignees: Schema.Array(KanbanItemAssignee),
  notes: Schema.Array(KanbanItemNote),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionKanbanItem = typeof ProjectionKanbanItem.Type;

export const GetProjectionKanbanItemInput = Schema.Struct({
  itemId: KanbanItemId,
});
export type GetProjectionKanbanItemInput = typeof GetProjectionKanbanItemInput.Type;

export interface ProjectionKanbanItemRepositoryShape {
  readonly upsert: (item: ProjectionKanbanItem) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionKanbanItemInput,
  ) => Effect.Effect<Option.Option<ProjectionKanbanItem>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionKanbanItem>,
    ProjectionRepositoryError
  >;
}

export class ProjectionKanbanItemRepository extends ServiceMap.Service<
  ProjectionKanbanItemRepository,
  ProjectionKanbanItemRepositoryShape
>()("t3/persistence/Services/ProjectionKanbanItems/ProjectionKanbanItemRepository") {}
