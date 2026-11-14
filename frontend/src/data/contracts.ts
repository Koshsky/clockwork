import type {
  DtoAdminUserResponse, DtoAssignmentResponse, DtoAuditEventView, DtoAutoCreateConfig,
  DtoCommentResponse, DtoCreateAssignmentRequest, DtoCreateCommentRequest,
  DtoCreateDependencyRequest, DtoCreateMilestoneRequest, DtoCreateProcessRequest,
  DtoCreateProjectRequest, DtoCreateProjectResponse, DtoCreateResourceRequest,
  DtoCreateStateRequest, DtoCreateTaskRequest, DtoCreateUserRequest, DtoCreateUserResult,
  DtoDependencyResponse, DtoMatrixCell, DtoMilestoneResponse, DtoPermission,
  DtoPresetRuleInput, DtoPresetRuleView, DtoPresetUpdateInput, DtoPresetUpsertInput,
  DtoPresetView, DtoProcessPlanning, DtoProcessResponse, DtoProject,
  DtoProjectPlanning, DtoProjectResponse, DtoResourceAbsenceResponse,
  DtoResourceCalendar, DtoResourceMemberResponse, DtoResourceResponse,
  DtoRoutePolicyView, DtoStateResponse, DtoStructureUserResponse, DtoTaskPlanning,
  DtoTaskResponse, DtoUpdateDependencyRequest, DtoUpdateMilestoneRequest,
  DtoUpdateProcessRequest, DtoUpdateProjectRequest, DtoUpdateResourceRequest,
  DtoUpdateStateRequest, DtoUpdateTaskRequest, DtoUpdateUserRequest,
  DtoUserInfo, DtoUserPermissionsInput, DtoUserPermissionsView, DtoUserResponse,
  DtoUserStatesResponse, DtoUserStateResponse, EngineKindInfo,
} from '@/api'

export interface DataFailure {
  kind: 'unauthenticated' | 'forbidden' | 'not-found' | 'validation' | 'conflict' |
    'unavailable' | 'storage' | 'unexpected'
  message: string
  code?: string
}

export type ReadResult<T> =
  | { status: 'ok'; data: T; source: 'snapshot' | 'refresh'; coverage?: SnapshotCoverage; baseline?: Record<string, string> }
  | { status: 'missing' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: DataFailure }

// Queued confirms persistence of the command, not atomicity of the local projection
// or acceptance by the server. Legacy cannot provide the future desktop transaction.
export type CommandResult<T> = (
  | { status: 'confirmed'; data: T }
  | { status: 'queued' }
  | { status: 'rejected' | 'conflict' | 'unknown'; error: DataFailure }
) & { operationId?: string; steps?: CommandStep[]; baseline?: Record<string, string>; sessionContextId?: string }

export interface CommandStep {
  operationId: string
  status: 'confirmed' | 'queued' | 'unsubmitted' | 'rejected' | 'conflict' | 'unknown'
  error?: DataFailure
}

export interface SnapshotCoverage {
  completeness: 'complete' | 'partial' | 'unknown'
  ranges?: DateRange[]
}

export interface ReadOptions {
  locale?: 'ru' | 'en'
  source: 'snapshot' | 'refresh'
  signal?: AbortSignal
}

export interface CommandOptions {
  locale?: 'ru' | 'en'
  operationId?: string
  preconditions?: Record<string, string>
  temporaryId?: number
  signal?: AbortSignal
}

export interface PageQuery {
  limit?: number
  offset?: number
  search?: string
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface DateRange {
  start: string
  end: string
}

interface Operation<Input, Output> {
  input: Input
  output: Output
}

// Generated DTOs remain the shared business shapes; HTTP envelopes and client
// classes are deliberately absent from these ports.
export interface ReadOperations {
  'project.list': Operation<PageQuery & { ownerId?: number }, Page<DtoProject>>
  'planning.projects': Operation<void, DtoProjectPlanning>
  'planning.processes': Operation<void, DtoProcessPlanning>
  'planning.tasks': Operation<void, DtoTaskPlanning>
  'resource.list': Operation<PageQuery & { ownerId?: number }, Page<DtoResourceResponse>>
  'resource.header': Operation<{ ownerId?: number }, DtoResourceResponse[]>
  'resource.members': Operation<{ resourceId: number }, DtoResourceMemberResponse[]>
  'resource.calendar': Operation<DateRange, DtoResourceCalendar[]>
  'resource.absences': Operation<DateRange & { resourceId: number }, DtoResourceAbsenceResponse[]>
  'employee.list': Operation<PageQuery & { terminated?: boolean; staffOnly?: boolean; preset?: string; managerId?: number; includeHash?: boolean }, Page<DtoUserResponse>>
  'timesheet.periods': Operation<DateRange & { employeeIds: number[] }, DtoUserStatesResponse[]>
  'timesheet.states': Operation<void, DtoStateResponse[]>
  'permissions.current': Operation<void, DtoPermission[]>
  'account.list': Operation<PageQuery & { preset?: string; managerId?: number; includeHash?: boolean }, Page<DtoAdminUserResponse>>
  'account.structure': Operation<void, DtoStructureUserResponse[]>
  'account.profile': Operation<{ userId?: number } | void, DtoUserInfo>
  'account.detail': Operation<{ userId: number }, DtoAdminUserResponse>
  'users.directory': Operation<void, DtoUserInfo[]>
  'timesheet.employeePeriods': Operation<DateRange & { userId: number }, DtoUserStateResponse[]>
  'assignment.catalog': Operation<PageQuery & { ownerId?: number }, Page<DtoAssignmentResponse>>
  'rbac.presets': Operation<void, DtoPresetView[]>
  'rbac.rules': Operation<void, DtoPresetRuleView[]>
  'rbac.matrix': Operation<void, DtoMatrixCell[]>
  'rbac.policies': Operation<void, DtoRoutePolicyView[]>
  'rbac.kinds': Operation<void, EngineKindInfo[]>
  'rbac.configuration': Operation<void, {
    presets: DtoPresetView[]; rules: DtoPresetRuleView[]; matrix: DtoMatrixCell[]
    routePolicies: DtoRoutePolicyView[]; kinds: EngineKindInfo[]
  }>
  'rbac.user': Operation<{ userId: number }, DtoUserPermissionsView>
  'template.configuration': Operation<void, DtoAutoCreateConfig>
  'comment.list': Operation<{ taskId: number }, DtoCommentResponse[]>
  'assignment.list': Operation<{ taskId: number }, DtoAssignmentResponse[]>
  'sync.queue': Operation<void, PendingCommand[]>
  'audit.events': Operation<PageQuery & {
    userId?: number; user?: string; entity?: string; action?: string; status?: string
    from?: string; to?: string; id?: string; ip?: string
  }, Page<DtoAuditEventView>>
}

type CrudOperations<Name extends string, Create, Update, Entity> = {
  [K in `${Name}.create`]: Operation<Create, Entity>
} & {
  [K in `${Name}.update`]: Operation<{ id: number; patch: Update }, Entity>
} & {
  [K in `${Name}.delete`]: Operation<{ id: number }, null>
}

export interface DesktopMutation {
  preconditions?: Record<string, string>
  route: string
  path?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  tempId?: number
  locale?: 'ru' | 'en'
}

export type CommandOperations =
  CrudOperations<'project', DtoCreateProjectRequest, DtoUpdateProjectRequest, DtoCreateProjectResponse | DtoProjectResponse> &
  CrudOperations<'process', DtoCreateProcessRequest, DtoUpdateProcessRequest, DtoProcessResponse> &
  CrudOperations<'task', DtoCreateTaskRequest, DtoUpdateTaskRequest, DtoTaskResponse> &
  CrudOperations<'milestone', DtoCreateMilestoneRequest, DtoUpdateMilestoneRequest, DtoMilestoneResponse> &
  CrudOperations<'resource', DtoCreateResourceRequest, DtoUpdateResourceRequest, DtoResourceResponse> &
  CrudOperations<'state', DtoCreateStateRequest, DtoUpdateStateRequest, DtoStateResponse> & {
    'task.move': Operation<{ id: number; start: string; end: string }, DtoTaskPlanning>
    'dependency.create': Operation<{ taskId: number; dependency: DtoCreateDependencyRequest }, DtoDependencyResponse>
    'dependency.update': Operation<{ taskId: number; id: number; patch: DtoUpdateDependencyRequest }, DtoDependencyResponse>
    'dependency.delete': Operation<{ taskId: number; id: number }, null>
    'assignment.create': Operation<DtoCreateAssignmentRequest, DtoAssignmentResponse>
    'assignment.delete': Operation<{ id: number }, null>
    'resource.addMember': Operation<{ resourceId: number; userId: number }, null>
    'resource.removeMember': Operation<{ resourceId: number; userId: number }, null>
    'timesheet.assignRange': Operation<DateRange & { userId: number; stateId: number }, null>
    'timesheet.clearRange': Operation<DateRange & { userId: number; stateId?: number }, null>
    'project.reorder': Operation<{ ids: number[] }, null>
    'process.reorder': Operation<{ projectId: number; ids: number[] }, null>
    'task.reorder': Operation<{ processId: number; ids: number[] }, null>
    'comment.create': Operation<{ taskId: number; comment: DtoCreateCommentRequest }, DtoCommentResponse>
    'comment.delete': Operation<{ taskId: number; id: number }, null>
    'account.create': Operation<DtoCreateUserRequest, DtoCreateUserResult>
    'account.update': Operation<{ id: number; patch: DtoUpdateUserRequest }, DtoAdminUserResponse>
    'account.delete': Operation<{ id: number }, null>
    'account.setManager': Operation<{ id: number; managerId: number | null }, null>
    'rbac.upsertRule': Operation<DtoPresetRuleInput, DtoPresetRuleView>
    'rbac.deleteRule': Operation<{ id: number }, null>
    'rbac.createPreset': Operation<DtoPresetUpsertInput, DtoPresetView>
    'rbac.updatePreset': Operation<{ tag: string; patch: DtoPresetUpdateInput }, DtoPresetView>
    'rbac.deletePreset': Operation<{ tag: string }, null>
    'rbac.saveUser': Operation<{ userId: number; permissions: DtoUserPermissionsInput }, DtoUserPermissionsView>
    'rbac.reset': Operation<void, null>
    'template.save': Operation<DtoAutoCreateConfig, DtoAutoCreateConfig>
  }

export interface ReadPort {
  read<K extends keyof ReadOperations>(
    operation: K, input: ReadOperations[K]['input'], options: ReadOptions,
  ): Promise<ReadResult<ReadOperations[K]['output']>>
}

export interface CommandPort {
  execute<K extends keyof CommandOperations>(
    operation: K, input: CommandOperations[K]['input'], options?: CommandOptions,
  ): Promise<CommandResult<CommandOperations[K]['output'] | null>>
}

export type Unsubscribe = () => void
export interface Subscription<T> {
  subscribe(listener: (state: T) => void): Unsubscribe
}

export interface SessionState {
  user: DtoUserInfo | null
  mode: 'anonymous' | 'online' | 'offline' | 'recovering'
}

// Secrets have a separate online-only contract and can never become outbox commands.
export interface SessionPort extends Subscription<SessionState> {
  current(): SessionState
  login(username: string, password: string): Promise<ReadResult<SessionState>>
  enterOffline(username?: string): Promise<ReadResult<SessionState>>
  refresh(): Promise<ReadResult<SessionState>>
  logout(): Promise<void>
  changePassword(oldPassword: string, newPassword: string): Promise<CommandResult<null>>
  resetPassword(userId: number): Promise<CommandResult<{ password: string }>>
}

export interface PlatformCapabilities {
  offlineReads: boolean
  offlineCommands: ReadonlyArray<OfflineCommand>
  serverSelection: boolean
  queueControls: boolean
}

// Expanding online-only administration/comments to offline requires a deliberate
// contract change; a platform flag alone must not start persisting those payloads.
export type OfflineCommand = Exclude<keyof CommandOperations,
  `account.${string}` | `comment.${string}` | `rbac.${string}` | `template.${string}`>

export interface SyncState {
  connection: 'online' | 'offline' | 'checking'
  phase: 'idle' | 'pulling' | 'pushing' | 'paused'
  pending: number
  rejected: number
  nextRefreshAt: number | null
}

export interface PendingCommand {
  operationId: string
  operation?: OfflineCommand
  status: 'pending' | 'unknown' | 'conflict' | 'rejected' | 'quarantined'
  error?: DataFailure
}

export interface SyncPort extends Subscription<SyncState> {
  current(): SyncState
  pull(): Promise<ReadResult<null>>
  push(): Promise<ReadResult<null>>
  retry(operationId: string): Promise<void>
  discard(operationIds: string[]): Promise<void>
  selectServer(server: string): Promise<void>
}

export interface ApplicationData {
  scope(): { server: string; accountId: number } | null
  reads: ReadPort
  commands: CommandPort
  session: SessionPort
  sync: SyncPort
  capabilities: PlatformCapabilities
  changes: Subscription<{ operations: Array<keyof ReadOperations> }>
}

// The first consumer migrates without pretending that other domains already have
// adapters. Future composition can implement this port with ReadPort/CommandPort.
export interface TaskDataPort {
  readPlanning(options: ReadOptions): Promise<ReadResult<DtoTaskPlanning>>
  update(id: number, patch: DtoUpdateTaskRequest, options?: CommandOptions): Promise<CommandResult<DtoTaskResponse | null>>
}
