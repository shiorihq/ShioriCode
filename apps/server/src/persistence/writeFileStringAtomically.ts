import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Path } from "effect";

export interface AtomicStringWriteOptions {
  readonly mode?: number;
}

export const writeFileStringAtomically = (
  targetPath: string,
  contents: string,
  options?: AtomicStringWriteOptions,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

    const chmodIfPossible = (pathToChmod: string) =>
      options?.mode === undefined
        ? Effect.void
        : fs.chmod(pathToChmod, options.mode).pipe(Effect.orElseSucceed(() => undefined));

    const write = Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
      yield* fs.writeFileString(tempPath, contents);
      yield* chmodIfPossible(tempPath);
      yield* fs.rename(tempPath, targetPath);
      yield* chmodIfPossible(targetPath);
    });

    yield* write.pipe(
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))),
    );
  });
