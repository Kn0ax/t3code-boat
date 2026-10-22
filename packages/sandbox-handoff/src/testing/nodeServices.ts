// @effect-diagnostics nodeBuiltinImport:off - Test-only bridge from Effect's platform services to the host's fs and processes.
/**
 * Real `FileSystem`, `Path` and `ChildProcessSpawner` services for tests that
 * run git against temporary repositories.
 *
 * This package does not depend on `@effect/platform-node`, whose
 * `NodeServices.layer` is what the server provides, so tests get this small
 * equivalent: the file system covers exactly the operations the package uses
 * (the rest fail as "not found"), and the spawner runs standard commands with
 * piped output. It is not exported from the package.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

const ERROR_TAGS: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: "NotFound",
  ENOTDIR: "NotFound",
  EEXIST: "AlreadyExists",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EBUSY: "Busy",
};

const toPlatformError =
  (module: string, method: string, pathOrDescriptor?: string) =>
  (cause: unknown): PlatformError.PlatformError => {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
    return PlatformError.systemError({
      _tag: ERROR_TAGS[code] ?? "Unknown",
      module,
      method,
      ...(pathOrDescriptor === undefined ? {} : { pathOrDescriptor }),
      cause,
    });
  };

const fsCall = <A>(method: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: toPlatformError("FileSystem", method, path) });

const optionalDate = (date: Date): Option.Option<Date> =>
  Number.isNaN(date.getTime()) ? Option.none() : Option.some(date);

const toInfo = (stats: NodeFS.Stats): FileSystem.File.Info => ({
  type: stats.isFile()
    ? "File"
    : stats.isDirectory()
      ? "Directory"
      : stats.isSymbolicLink()
        ? "SymbolicLink"
        : "Unknown",
  mtime: optionalDate(stats.mtime),
  atime: optionalDate(stats.atime),
  birthtime: optionalDate(stats.birthtime),
  dev: BigInt(stats.dev),
  ino: Option.some(BigInt(stats.ino)),
  mode: stats.mode,
  nlink: Option.some(BigInt(stats.nlink)),
  uid: Option.some(stats.uid),
  gid: Option.some(stats.gid),
  rdev: Option.some(BigInt(stats.rdev)),
  size: ByteSize.bytes(stats.size),
  blksize: Option.some(ByteSize.bytes(stats.blksize)),
  blocks: Option.some(BigInt(stats.blocks)),
});

const makeTempDirectory = (options?: {
  readonly directory?: string | undefined;
  readonly prefix?: string | undefined;
}) =>
  fsCall("makeTempDirectory", options?.directory ?? NodeOS.tmpdir(), () =>
    NodeFSP.mkdtemp(NodePath.join(options?.directory ?? NodeOS.tmpdir(), options?.prefix ?? "")),
  );

const remove = (
  path: string,
  options?: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined },
) =>
  fsCall("remove", path, () =>
    NodeFSP.rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
  );

const fileSystem = FileSystem.makeNoop({
  access: (path) => fsCall("access", path, () => NodeFSP.access(path)),
  exists: (path) =>
    fsCall("exists", path, () =>
      NodeFSP.access(path).then(
        () => true,
        () => false,
      ),
    ),
  copyFile: (from, to) => fsCall("copyFile", from, () => NodeFSP.copyFile(from, to)),
  makeDirectory: (path, options) =>
    fsCall("makeDirectory", path, () =>
      NodeFSP.mkdir(path, {
        recursive: options?.recursive ?? false,
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
      }).then(() => undefined),
    ),
  makeTempDirectory,
  makeTempDirectoryScoped: (options) =>
    Effect.acquireRelease(makeTempDirectory(options), (directory) =>
      remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  readDirectory: (path) => fsCall("readDirectory", path, () => NodeFSP.readdir(path)),
  readFile: (path) =>
    fsCall("readFile", path, () => NodeFSP.readFile(path).then((data) => new Uint8Array(data))),
  readFileString: (path) => fsCall("readFileString", path, () => NodeFSP.readFile(path, "utf8")),
  realPath: (path) => fsCall("realPath", path, () => NodeFSP.realpath(path)),
  remove,
  stat: (path) => fsCall("stat", path, () => NodeFSP.stat(path).then(toInfo)),
  utimes: (path, atime, mtime) => fsCall("utimes", path, () => NodeFSP.utimes(path, atime, mtime)),
  writeFile: (path, data) => fsCall("writeFile", path, () => NodeFSP.writeFile(path, data)),
  writeFileString: (path, data) =>
    fsCall("writeFileString", path, () => NodeFSP.writeFile(path, data, "utf8")),
});

const spawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    if (command._tag !== "StandardCommand") {
      return yield* Effect.die(new Error("The test spawner runs standard commands only."));
    }
    const { options } = command;
    const env = options.extendEnv === true ? { ...process.env, ...options.env } : options.env;
    const stdin = typeof options.stdin === "string" ? options.stdin : "pipe";
    const [child, exited] = yield* Effect.acquireRelease(
      Effect.callback<
        readonly [NodeChildProcess.ChildProcess, Promise<number>],
        PlatformError.PlatformError
      >((resume) => {
        const spawned = NodeChildProcess.spawn(command.command, [...command.args], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(env === undefined ? {} : { env }),
          stdio: [stdin === "inherit" || stdin === "ignore" ? stdin : "pipe", "pipe", "pipe"],
        });
        const exit = new Promise<number>((resolve) => {
          spawned.once("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
        });
        spawned.once("error", (error) =>
          resume(Effect.fail(toPlatformError("ChildProcess", "spawn", command.command)(error))),
        );
        spawned.once("spawn", () => resume(Effect.succeed([spawned, exit] as const)));
      }),
      ([spawned]) =>
        Effect.sync(() => {
          if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill("SIGKILL");
        }),
    );
    const output = (stream: NodeJS.ReadableStream | null) =>
      stream === null
        ? Stream.empty
        : Stream.fromAsyncIterable(
            stream as AsyncIterable<Uint8Array>,
            toPlatformError("ChildProcess", "stdout", command.command),
          );
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(child.pid ?? 0),
      exitCode: Effect.promise(() => exited).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
      isRunning: Effect.sync(() => child.exitCode === null && child.signalCode === null),
      kill: () => Effect.sync(() => void child.kill("SIGTERM")),
      unref: Effect.sync(() => {
        child.unref();
        return Effect.sync(() => void child.ref());
      }),
      stdin: Sink.drain,
      stdout: output(child.stdout),
      stderr: output(child.stderr),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }),
);

export const layer = Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem, fileSystem),
  Path.layer,
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
);

export type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
