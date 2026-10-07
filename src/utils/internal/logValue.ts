/**
 * @fileoverview The walk every log sink runs over log data before writing it:
 * pino's `formatters.log` for the process log and `interactions.log`, the OTLP
 * export's attributes, and the `ctx.log` client mirror. One walk, so every sink
 * shares one depth bound, one ceiling on reads, one ceiling on the characters
 * written, one bound on repeated content, one cycle rule, one key matcher, and
 * one answer for a value whose read throws.
 * A leaf module, so the logger and the mirror use it without importing each other.
 * @module src/utils/internal/logValue
 */
import { McpError } from '@/types-global/errors.js';
import { isSensitiveKey } from '@/utils/security/sensitiveFields.js';

/**
 * Depth bound, counted from the record root: objects through depth 15 are
 * written, and an object at depth 16 is written as `'[MaxDepth]'`. Above the
 * deepest framework record — a union argument rejection's
 * `errorData.issues[i].errors[j][k].path`, at 7 — with margin, and far below
 * the depth at which a recursive copy overflows the stack (10,000 levels on
 * Node), which is why the walk keeps a bound at all.
 */
const MAX_DEPTH = 16;

/**
 * Reads one walk makes: one for each object it reaches, fresh or repeated, and
 * for each field and array element that is not an object, a redacted field
 * included; {@link DEPTH_BOUND_READS} for an object at {@link MAX_DEPTH}. The
 * read past the last is written as `'[Truncated]'` and the walk stops there. A
 * getter, a Proxy, or a mirror's `toJSON()` can build new data on every read,
 * which neither the cycle check nor the bound on repeated content ever sees
 * twice: an object whose three getters each build another like it is 43
 * million objects down to the depth bound, a 308 MB line written in 3–35 s.
 * Bounded, it writes 0.8 MB in 14–38 ms on Bun and Node, and 3.7 MB in
 * 75–115 ms when each built object also carries 200 numeric fields. Distinct
 * data takes a read for each object and each field: a record of 100,000
 * distinct one-field objects takes half the reads and is written whole.
 */
const MAX_READS = 400_000;

/**
 * Reads an object at {@link MAX_DEPTH} counts. Data built on every read nests
 * as deep as the walk goes, so most of what it reaches sits at the depth bound;
 * held data rarely reaches it more than a few times.
 */
const DEPTH_BOUND_READS = 10;

/**
 * Characters of repeated content one walk writes. Content is repeated when the
 * walk already wrote it: an object reached again on another path, and everything
 * beneath it, and a string or field name of {@link LONG_TEXT} characters or more
 * written before. Each repeated value is charged about the characters it writes,
 * quotes, braces, and separators included, so 20,000 rows sharing one `tags: []`
 * are written whole. Bounds what sharing multiplies: a 100 KB string shared
 * 6,000 times writes 600 MB uncharged and 1.1 MB charged, as does one held by
 * 2,000 distinct objects. Content written once is bounded only by
 * {@link MAX_WRITTEN_CHARS}.
 */
const MAX_REPEATED_CHARS = 1_000_000;

/**
 * Characters one walk writes: every string, field name, and primitive, repeated
 * or not, charged about the characters it writes — a string with its quotes, a
 * field name with its quotes, colon, and comma. The value past it is written as
 * `'[Truncated]'`, a field name past it as `'[Truncated]': '[Truncated]'`, and
 * the walk stops there. Bounds what neither the read ceiling nor the bound on
 * repeated content sees: data a getter builds on every read, each object it
 * builds carrying 50 fields of one 1,000-character string, wrote 284 MB within
 * {@link MAX_READS}. A 10 MB string is written whole; a 20 MB one is cut.
 */
const MAX_WRITTEN_CHARS = 16 * 1024 * 1024;

/**
 * Length from which the walk remembers a string or field name by its value, so
 * that writing it again from another object is repeated content. Shorter text is
 * written on every reference: remembering it would cost every record.
 */
const LONG_TEXT = 1_024;

/**
 * Longest text the walk remembers under its own value. V8 hashes a longer
 * string by its length alone, so a set of same-length long strings compares
 * each lookup with every one of them up to the first character that differs:
 * 2,000 distinct strings of 20,000 characters took 1.3 s on Node, 4,000 took
 * 5.4 s. Longer text is remembered under {@link longKey}'s sample.
 */
const HASHED_TEXT = 16_383;

/**
 * Distinct texts sharing one {@link longKey} sample that a lookup compares one
 * by one. Past this many, they are kept by {@link contentHash}, so text that
 * matches at every sampled window stays linear: 2,000 texts of 20,000
 * characters differing 3,000 characters in take 60–160 ms on Bun and Node,
 * where comparing them one by one took 210–330 ms, growing with the square.
 */
const SAMPLE_BUCKET = 8;

/**
 * The long texts remembered under one {@link longKey}: a list of up to
 * {@link SAMPLE_BUCKET}, then those texts by {@link contentHash}.
 */
type LongBucket = string[] | Map<number, string[]>;

/** What {@link read} returns for a property whose read threw; written as `'[Unreadable]'`. */
const UNREADABLE = Symbol('unreadable');

/** What {@link walkValue} returns for a value a bound stopped; written as `'[Truncated]'`. */
const CUT = Symbol('cut');

/** How an entered object is written. */
type Shape = 'aggregateError' | 'array' | 'error' | 'mcpError' | 'record';

/** One walk over one record's data. */
interface Walk {
  /** The objects the walk is inside, outermost first. */
  readonly ancestors: object[];
  /** Characters of repeated content the walk may still write. */
  chars: number;
  /** Whether a key of the root object is exempt from the key matcher. */
  readonly exemptRootKey: ((key: string) => boolean) | undefined;
  /** Whether an `Error` keeps its `stack` (log mode). */
  readonly includeStack: boolean;
  /** Every string and field name of {@link LONG_TEXT} characters or more the walk wrote, by {@link longKey}. */
  long: Map<string, LongBucket> | undefined;
  /**
   * `log`: the copy every log record writes. `mirror`: the copy the `ctx.log`
   * client mirror sends — what `JSON.stringify` reads (an object's `toJSON()`
   * result, else its own enumerable fields), with an `Error` as `{ type, message }`.
   */
  readonly mode: 'log' | 'mirror';
  /**
   * The stack of the `Error` whose `cause` or `errors` the walk is writing; an
   * `Error` there with the same stack is written without it. A rethrown
   * `tryCatch` error carries the throw site's stack and keeps the original on
   * `cause`, so without this one stack would be written once per level.
   */
  parentStack: unknown;
  /** Reads the walk may still make. */
  reads: number;
  /** Whether the walk is inside repeated content, where every value is charged. */
  repeating: boolean;
  /** Characters the walk may still write, repeated or not ({@link MAX_WRITTEN_CHARS}). */
  room: number;
  /** Every object the walk has entered, and each `toJSON()` result, so one reached again is known as a repeat. */
  readonly seen: Set<object>;
  /** Set when the reads or the characters ran out: every array and object the walk is in ends there. */
  stopped: boolean;
}

/** `object[key]`, or {@link UNREADABLE} when the read throws: a getter, a Proxy trap, a revoked Proxy. */
function read(object: object, key: PropertyKey): unknown {
  try {
    return (object as Record<PropertyKey, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * Copies a value into the JSON-safe form a sink writes, or returns `undefined`
 * to drop it. Keeps primitives and drops functions; every key {@link isSensitiveKey}
 * matches is written as `'[REDACTED]'`. A reference back to an object the walk is
 * inside is written as `'[Circular]'`, an object at {@link MAX_DEPTH} as
 * `'[MaxDepth]'`, and a value whose read throws as `'[Unreadable]'`. Returns
 * {@link CUT} — written as `'[Truncated]'` — for the read past {@link MAX_READS}
 * and the value past {@link MAX_WRITTEN_CHARS}, after which the walk stops, and
 * for repeated content that does not fit in what is left of
 * {@link MAX_REPEATED_CHARS}, after which the repeated array or object it sits in
 * ends; a later repeat that still fits is written.
 *
 * Log mode writes a `Date` as its ISO string (`null` when invalid, as
 * `JSON.stringify` does), a `URL` as its string, and an `Error` through
 * {@link walkError}; copies arrays and plain objects; and drops any other object
 * without reading it — `AbortSignal`, `Map`, `Set`, `Promise`, storage handles —
 * since their prototype getters enforce receiver checks and throw (#32).
 */
function walkValue(value: unknown, depth: number, walk: Walk): unknown {
  if (value === UNREADABLE) return marker('[Unreadable]', walk);
  const t = typeof value;
  if (t === 'string') {
    const text = value as string;
    const repeated = walk.repeating || (text.length >= LONG_TEXT && seenLong(text, walk));
    return write(text, text.length + 2, repeated, walk);
  }
  if (t === 'undefined' || t === 'function') return;
  if (value === null || t !== 'object') {
    return write(value, primitiveChars(value), walk.repeating, walk);
  }
  if (--walk.reads < 0) return stop(walk);

  // The object a reference names: what the cycle check and the repeat check track, even when
  // mirror mode writes its `toJSON()` result, which can be a fresh object on every call.
  const original = value as object;
  let object = original;
  let shape: Shape;
  let keys: string[] | undefined;
  let length = 0;
  try {
    if (Array.isArray(object)) {
      shape = 'array';
    } else if (walk.mode === 'log') {
      // A plain object, the common case, is settled before any `instanceof` walk of its prototype chain.
      const proto = Object.getPrototypeOf(object);
      if (proto === Object.prototype || proto === null) {
        shape = 'record';
      } else if (object instanceof Error) {
        shape = errorShape(object);
      } else if (object instanceof Date) {
        return walkValue(Number.isNaN(object.getTime()) ? null : object.toISOString(), depth, walk);
      } else if (object instanceof URL) {
        return walkValue(object.toString(), depth, walk);
      } else {
        return;
      }
    } else if (object instanceof Error) {
      shape = errorShape(object);
    } else {
      const { toJSON } = object as { toJSON?: unknown };
      if (typeof toJSON === 'function') {
        const json: unknown = toJSON.call(object);
        if (json === null || typeof json !== 'object') return walkValue(json, depth, walk);
        object = json;
      }
      shape = Array.isArray(object) ? 'array' : 'record';
    }
    if (
      walk.ancestors.includes(original) ||
      (object !== original && walk.ancestors.includes(object))
    ) {
      return marker('[Circular]', walk);
    }
    if (depth >= MAX_DEPTH) {
      walk.reads -= DEPTH_BOUND_READS - 1;
      return walk.reads < 0 ? stop(walk) : marker('[MaxDepth]', walk);
    }
    // Enumerated only now, so an object past the depth bound is never enumerated.
    if (shape === 'record') keys = Object.keys(object);
    else if (shape === 'array') length = (object as unknown[]).length;
  } catch {
    return marker('[Unreadable]', walk);
  }

  const repeated =
    walk.repeating || walk.seen.has(original) || (object !== original && walk.seen.has(object));
  if (repeated) {
    if (!charge(keys ? 2 + nameChars(keys) : 2 + length, walk)) return CUT;
  } else {
    walk.seen.add(original);
    if (object !== original) walk.seen.add(object);
    if (keys && walk.long && !chargeLongNames(keys, walk.long, walk)) return CUT;
  }
  const outside = walk.repeating;
  walk.repeating = repeated;
  // No `finally`: every read below is guarded, so nothing throws between the push and the pop.
  walk.ancestors.push(original);
  const out =
    shape === 'array'
      ? walkArray(object, length, depth, walk)
      : shape === 'record'
        ? walkRecord(object, keys as string[], depth, walk)
        : walkError(object as Error, shape, depth, walk);
  walk.ancestors.pop();
  walk.repeating = outside;
  return out;
}

/**
 * Walks one field or array element one level down: an object pays its read in
 * {@link walkValue}, any other value pays one here.
 */
function walkField(value: unknown, depth: number, walk: Walk): unknown {
  return (value === null || typeof value !== 'object') && --walk.reads < 0
    ? stop(walk)
    : walkValue(value, depth, walk);
}

/** Ends the walk: the read past {@link MAX_READS}, or the value past {@link MAX_WRITTEN_CHARS}. */
function stop(walk: Walk): typeof CUT {
  walk.stopped = true;
  return CUT;
}

/**
 * `value`, which writes `cost` characters: {@link CUT} when it is repeated
 * content that does not fit in the bound on repeats, and the end of the walk when
 * it does not fit in what is left of {@link MAX_WRITTEN_CHARS}.
 */
function write(value: unknown, cost: number, repeated: boolean, walk: Walk): unknown {
  if (repeated && !charge(cost, walk)) return CUT;
  walk.room -= cost;
  return walk.room < 0 ? stop(walk) : value;
}

/**
 * The characters a primitive other than a string writes. A safe integer's
 * digits are counted rather than converted: converting each number of a record
 * of 100,000 one-field objects made its walk a third slower on Bun.
 */
function primitiveChars(value: unknown): number {
  if (!Number.isSafeInteger(value)) return String(value).length;
  const n = value as number;
  const abs = n < 0 ? -n : n;
  let chars = n < 0 ? 2 : 1;
  for (let power = 10; abs >= power; power *= 10) chars++;
  return chars;
}

/** A marker the walk writes in place of a value, charged like any string. */
function marker(text: string, walk: Walk): unknown {
  return write(text, text.length + 2, walk.repeating, walk);
}

/** Charges `cost` characters of repeated content: false, and nothing charged, when fewer are left. */
function charge(cost: number, walk: Walk): boolean {
  if (cost > walk.chars) return false;
  walk.chars -= cost;
  return true;
}

/** Whether the walk wrote this long string or field name before; remembers it when not. */
function seenLong(text: string, walk: Walk): boolean {
  walk.long ??= new Map();
  return holdsLong(walk.long, text, true);
}

/** Remembers a long string or field name the walk writes. */
function rememberLong(text: string, walk: Walk): void {
  seenLong(text, walk);
}

/**
 * Whether `long` holds `text`, adding it when it does not and `add` is set.
 * Every match is confirmed by `===`, so distinct text is never taken for text
 * written before.
 */
function holdsLong(long: Map<string, LongBucket>, text: string, add: boolean): boolean {
  const key = longKey(text);
  const bucket = long.get(key);
  if (bucket === undefined) {
    if (add) long.set(key, [text]);
    return false;
  }
  if (Array.isArray(bucket)) {
    if (bucket.includes(text)) return true;
    if (add && bucket.push(text) > SAMPLE_BUCKET) {
      const byHash = new Map<number, string[]>();
      for (const held of bucket) pushByHash(byHash, contentHash(held), held);
      long.set(key, byHash);
    }
    return false;
  }
  const hash = contentHash(text);
  if (bucket.get(hash)?.includes(text)) return true;
  if (add) pushByHash(bucket, hash, text);
  return false;
}

/**
 * The key a long text is remembered under: the text itself up to
 * {@link HASHED_TEXT} characters, else its length and its first, middle, and
 * last 128 characters — shorter than {@link LONG_TEXT}, so never another text.
 */
function longKey(text: string): string {
  if (text.length <= HASHED_TEXT) return text;
  const middle = text.length >> 1;
  return `${text.length}:${text.slice(0, 128)}${text.slice(middle - 64, middle + 64)}${text.slice(-128)}`;
}

/** A 32-bit FNV-1a hash of every character of `text`. */
function contentHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash;
}

/** Adds `text` to the texts `byHash` keeps under `hash`. */
function pushByHash(byHash: Map<number, string[]>, hash: number, text: string): void {
  const texts = byHash.get(hash);
  if (texts) texts.push(text);
  else byHash.set(hash, [text]);
}

/** The characters a repeated object's field names write, each with its quotes, colon, and comma. */
function nameChars(keys: readonly string[]): number {
  let chars = 0;
  for (let i = 0; i < keys.length; i++) chars += (keys[i] as string).length + 4;
  return chars;
}

/**
 * Charges an object reached for the first time for each of its long field names
 * the walk wrote before; {@link walkRecord} remembers them as it writes them. False
 * when they do not fit: the object is then written as `'[Truncated]'`.
 */
function chargeLongNames(
  keys: readonly string[],
  long: Map<string, LongBucket>,
  walk: Walk,
): boolean {
  let cost = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (key.length >= LONG_TEXT && holdsLong(long, key, false)) cost += key.length + 4;
  }
  return cost === 0 || charge(cost, walk);
}

/** Which kind of `Error` `err` is, for {@link walkError}. */
function errorShape(err: Error): Shape {
  if (err instanceof McpError) return 'mcpError';
  return err instanceof AggregateError ? 'aggregateError' : 'error';
}

/**
 * Copies `length` elements of an array, each through {@link walkField}. Ends
 * where the walk stops, and a repeated array after the value that did not fit.
 */
function walkArray(array: object, length: number, depth: number, walk: Walk): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const value = walkField(read(array, i), depth + 1, walk);
    out.push(value === CUT ? '[Truncated]' : value);
    if (walk.stopped || (value === CUT && walk.repeating)) break;
  }
  return out;
}

/**
 * Copies the fields named by `keys`, each through {@link walkField}, redacting
 * each sensitive one — except, on the root object, a key the walk exempts —
 * for a read, though its value is never read, and dropping each that walks to
 * `undefined`. Each name is charged against {@link MAX_WRITTEN_CHARS} before its
 * value is read, a dropped field's included; a name that does not fit is written
 * as `'[Truncated]'`, and so is its value. Ends where the walk stops, and a
 * repeated object after the field that did not fit.
 */
function walkRecord(
  object: object,
  keys: readonly string[],
  depth: number,
  walk: Walk,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    walk.room -= key.length + 4;
    if (walk.room < 0) {
      stop(walk);
      out['[Truncated]'] = '[Truncated]';
      break;
    }
    if (key.length >= LONG_TEXT) rememberLong(key, walk);
    const field =
      isSensitiveKey(key) && !(depth === 0 && walk.exemptRootKey?.(key))
        ? --walk.reads < 0
          ? stop(walk)
          : marker('[REDACTED]', walk)
        : walkField(read(object, key), depth + 1, walk);
    if (field === undefined) continue;
    const value = field === CUT ? '[Truncated]' : field;
    // An own `__proto__` key (from `JSON.parse`) would hit the prototype setter.
    if (key === '__proto__') {
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } else {
      out[key] = value;
    }
    if (walk.stopped || (field === CUT && walk.repeating)) break;
  }
  return out;
}

/**
 * Sets one field of a written `Error` unless it walked to `undefined`. False
 * once the error must end there: the walk stopped, or a repeated error's field
 * did not fit.
 */
function put(out: Record<string, unknown>, key: string, field: unknown, walk: Walk): boolean {
  if (field !== undefined) out[key] = field === CUT ? '[Truncated]' : field;
  return !(walk.stopped || (field === CUT && walk.repeating));
}

/**
 * Writes one `Error`. Mirror mode: `{ type, message }`. Log mode: `type` (its
 * `name`), `message`, `stack` unless the walk is stack-free, a string `code` —
 * or an `McpError`'s numeric `code` and its `data` — and `cause` and an
 * `AggregateError`'s `errors`, each walked like any other value, so a nested
 * `Error` takes this same shape. No other own property is copied: runtimes put
 * request URLs (`path`, `input`) and server file paths (`sourceURL`) on them.
 * A stack equal to the parent error's — the error whose `cause` or `errors`
 * this one is — is left out, so a chain sharing one stack writes it once. An
 * unreadable `code` is left out; any other unreadable field is `'[Unreadable]'`.
 */
function walkError(err: Error, shape: Shape, depth: number, walk: Walk): Record<string, unknown> {
  const { parentStack } = walk;
  walk.parentStack = undefined;
  const out: Record<string, unknown> = {};
  if (
    put(out, 'type', walkValue(read(err, 'name'), depth + 1, walk), walk) &&
    put(out, 'message', walkValue(read(err, 'message'), depth + 1, walk), walk) &&
    walk.mode === 'log'
  ) {
    const stack = walk.includeStack ? read(err, 'stack') : undefined;
    let more =
      stack === undefined ||
      stack === parentStack ||
      put(out, 'stack', walkValue(stack, depth + 1, walk), walk);
    if (more) {
      const code = read(err, 'code');
      if (shape === 'mcpError') {
        if (code !== UNREADABLE) out.code = code;
        more = put(out, 'data', walkValue(read(err, 'data'), depth + 1, walk), walk);
      } else if (typeof code === 'string') {
        out.code = code;
      }
    }
    if (more) {
      walk.parentStack = stack === UNREADABLE ? undefined : stack;
      more = put(out, 'cause', walkValue(read(err, 'cause'), depth + 1, walk), walk);
      if (more && shape === 'aggregateError') {
        put(out, 'errors', walkValue(read(err, 'errors'), depth + 1, walk), walk);
      }
    }
  }
  walk.parentStack = parentStack;
  return out;
}

/** A fresh walk: nothing entered yet, every read left, and the full bound on repeated content. */
function newWalk(
  mode: Walk['mode'],
  includeStack: boolean,
  exemptRootKey?: (key: string) => boolean,
): Walk {
  return {
    ancestors: [],
    chars: MAX_REPEATED_CHARS,
    exemptRootKey,
    includeStack,
    long: undefined,
    mode,
    parentStack: undefined,
    reads: MAX_READS,
    repeating: false,
    room: MAX_WRITTEN_CHARS,
    seen: new Set(),
    stopped: false,
  };
}

/**
 * The JSON-safe form a log record writes for `value`, as the walk pino runs on
 * every record produces it. With `includeStack: false`, every `Error` in it is
 * written without its `stack`: a stack-free record passes its fields through
 * this first, since the walk pino runs keeps stacks. A key of `value` itself
 * for which `exemptRootKey` returns true is never redacted; the same key deeper
 * down is.
 *
 * @internal Exported for the logger, stack-free log records, `ctx.log` data a spread cannot
 * read, and unit testing. Not part of the public API.
 */
export function toLogValue(
  value: unknown,
  options: { exemptRootKey?: ((key: string) => boolean) | undefined; includeStack?: boolean } = {},
): unknown {
  const out = walkValue(
    value,
    0,
    newWalk('log', options.includeStack ?? true, options.exemptRootKey),
  );
  return out === CUT ? '[Truncated]' : out;
}

/**
 * The copy of a `ctx.log` call's data the client mirror sends: what
 * `JSON.stringify` reads from it (an object's `toJSON()` result, else its own
 * enumerable fields), with every sensitive field masked as `'[REDACTED]'` and
 * every `Error` written as `{ type, message }` — no stack, cause, or own
 * property such as a request URL. The process log's bounds and markers apply:
 * `'[Circular]'`, `'[MaxDepth]'` (the data's own fields sit at depth 1, as they
 * do in the log record), `'[Truncated]'` where the ceiling on reads, the ceiling
 * on characters written, or the bound on repeated content stops it — a `toJSON()`
 * result reached again from another object included — and `'[Unreadable]'`,
 * with data that has no readable keys at all as `{ data: '[Unreadable]' }`, as
 * the process log writes it. Nothing passes through `structuredClone`, which
 * rejects a `URL` or a function, and the input is never modified.
 *
 * @internal Masks the `ctx.log` mirror to the client. Not part of the public API.
 */
export function toMirrorValue(fields: Record<string, unknown>): Record<string, unknown> {
  const walk = newWalk('mirror', false);
  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch {
    return { data: '[Unreadable]' };
  }
  // On the ancestor stack for the whole walk, so a reference back to it is `'[Circular]'`.
  walk.ancestors.push(fields);
  return walkRecord(fields, keys, 0, walk);
}
