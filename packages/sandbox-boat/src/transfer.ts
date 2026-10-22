/**
 * Files over boat's 5 MiB file API limit, moved in parts.
 *
 * boat's file endpoints refuse anything over 5 MiB, and the SDK (1.9.4) has
 * no signed upload or download URL for a sandbox file: its artifact download
 * stops at 50 MiB and its own docs send larger files to SCP over SSH, which
 * the adapter has no key for. So a large file travels as parts under the
 * file API limit, split or joined inside the sandbox by these scripts, in a
 * scratch directory under the sandbox user's home that the file API can
 * reach. Every path is resolved the way the file API resolves it: `~` and
 * relative paths against the home directory.
 */

/** boat refuses file reads and writes over 5 MiB. */
export const MAX_BOAT_FILE_BYTES = 5 * 1024 * 1024;

/** One part of a large transfer, with headroom under the file API limit. */
export const BOAT_TRANSFER_PART_BYTES = 4 * 1024 * 1024;

/** Exit status of the read probe for a path that is not a regular file. */
export const BOAT_TRANSFER_NOT_FOUND_EXIT_CODE = 3;

const HOME = `[ -n "\${HOME:-}" ] || HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
[ -n "$HOME" ] || exit 1`;

const RESOLVE_PATH = `t3_path="$1"
case "$t3_path" in
  "~") t3_path="$HOME" ;;
  "~/"*) t3_path="$HOME/\${t3_path#??}" ;;
  /*) ;;
  *) t3_path="$HOME/$t3_path" ;;
esac`;

// Only a directory this module made is ever removed, whatever path arrives.
const OWN_DIR = `case "$2" in
  "$HOME"/.t3-transfer.*) ;;
  *) exit 2 ;;
esac`;

/** Prints a fresh scratch directory for the parts of a write. */
export const BOAT_TRANSFER_MKDIR_SCRIPT = `${HOME}
mktemp -d "$HOME/.t3-transfer.XXXXXXXX"`;

/**
 * Args: path, the file API limit, part size. Prints `small` for a file the
 * file API can read whole, else `split <bytes> <dir>` after writing the parts
 * `part.0000`, `part.0001`... into `dir`.
 */
export const BOAT_TRANSFER_SPLIT_SCRIPT = `${HOME}
${RESOLVE_PATH}
[ -f "$t3_path" ] || exit ${BOAT_TRANSFER_NOT_FOUND_EXIT_CODE}
t3_size="$(wc -c <"$t3_path")" || exit 1
t3_size=$((t3_size))
if [ "$t3_size" -le "$2" ]; then
  printf "small\\n"
  exit 0
fi
t3_dir="$(mktemp -d "$HOME/.t3-transfer.XXXXXXXX")" || exit 1
if ! split -a 4 -d -b "$3" -- "$t3_path" "$t3_dir/part."; then
  rm -rf -- "$t3_dir"
  exit 1
fi
printf "split %s %s\\n" "$t3_size" "$t3_dir"`;

/**
 * Args: path, parts directory, expected byte count. Joins the parts into the
 * path through a temp file, so a short join never replaces the file, and
 * removes the parts.
 */
export const BOAT_TRANSFER_JOIN_SCRIPT = `${HOME}
${RESOLVE_PATH}
${OWN_DIR}
case "$t3_path" in
  */*) mkdir -p -- "\${t3_path%/*}" || exit 1 ;;
esac
t3_partial="$t3_path.t3-partial"
if ! cat -- "$2"/part.* >"$t3_partial" || [ "$(($(wc -c <"$t3_partial")))" -ne "$3" ]; then
  rm -f -- "$t3_partial"
  exit 1
fi
mv -f -- "$t3_partial" "$t3_path" || exit 1
rm -rf -- "$2"`;

/** Args: unused, parts directory. */
export const BOAT_TRANSFER_CLEANUP_SCRIPT = `${HOME}
${OWN_DIR}
rm -rf -- "$2"`;

/** The parts' file names, in order: `split -d -a 4` numbering. */
export function boatTransferPartNames(byteCount: number): ReadonlyArray<string> {
  const count = Math.max(1, Math.ceil(byteCount / BOAT_TRANSFER_PART_BYTES));
  return Array.from({ length: count }, (_, index) => `part.${String(index).padStart(4, "0")}`);
}

export type BoatSplitAnswer =
  | { readonly _tag: "Small" }
  | { readonly _tag: "Split"; readonly byteCount: number; readonly dir: string }
  | { readonly _tag: "Invalid" };

/** Reads the split script's stdout; anything unexpected is `Invalid`. */
export function parseBoatSplitAnswer(stdout: string): BoatSplitAnswer {
  const line = stdout.trim();
  if (line === "small") {
    return { _tag: "Small" };
  }
  const match = /^split (\d+) (\/\S*\/\.t3-transfer\.[A-Za-z0-9]+)$/.exec(line);
  if (match === null) {
    return { _tag: "Invalid" };
  }
  const byteCount = Number(match[1]);
  return Number.isSafeInteger(byteCount)
    ? { _tag: "Split", byteCount, dir: match[2]! }
    : { _tag: "Invalid" };
}

/** The scratch directory the mkdir script printed, if it is one of ours. */
export function parseBoatTransferDir(stdout: string): string | undefined {
  const dir = stdout.trim();
  return /^\/\S*\/\.t3-transfer\.[A-Za-z0-9]+$/.test(dir) ? dir : undefined;
}
