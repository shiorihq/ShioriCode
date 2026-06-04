import { FileChange, FileChangeKind } from "../types.js";
import { Trigger, TriggerContext } from "./triggers.js";
export declare function every(intervalSeconds: number, callback: (ctx: TriggerContext) => Promise<void>): Trigger;
export declare function onFileChange(path: string, callback: (ctx: TriggerContext, changes: readonly FileChange[]) => Promise<void>): Trigger;
export declare const on_file_change: typeof onFileChange;
export { FileChange, FileChangeKind };
//# sourceMappingURL=helpers.d.ts.map