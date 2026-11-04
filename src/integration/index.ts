export {
  TaskClient,
  TaskClient as FoundryClient,
  selectTaskExecution,
  verifyTaskTicket,
} from './task-client.js';
export type { TaskClientOptions, TaskPlacement, TaskTicket, ShadowReceipt } from './task-client.js';
export { ContractRegistry, digest, json } from '../compiler/contracts.js';
export type { AccessContext, Json, ToolContract, TaskContract } from '../compiler/contracts.js';
export { TaskObserver } from '../exploration/task-observer.js';
export type { Binding, TaskTrace, TaskPlan } from '../compiler/task-ir.js';
export type { TaskArtifact, TaskOutcome, TaskCheckpoint } from '../runtime/task-runtime.js';
