import { LENGTH_PREFIX_BYTES, PAD_BUCKETS } from "./constants.js";
import { ProtocolError } from "./errors.js";

const BUCKET_SET: ReadonlySet<number> = new Set<number>(PAD_BUCKETS);

/**
 * Prefix a 2-byte big-endian length and zero-pad to the smallest allowed
 * bucket (256, 1024 or 4096 bytes). Rejects anything that does not fit.
 */
export function pad(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const total = data.length + LENGTH_PREFIX_BYTES;
  let bucket: number | undefined;
  for (const candidate of PAD_BUCKETS) {
    if (total <= candidate) {
      bucket = candidate;
      break;
    }
  }
  if (bucket === undefined) {
    throw new ProtocolError("too_large");
  }
  const out = new Uint8Array(bucket); // zero-filled
  out[0] = (data.length >> 8) & 0xff;
  out[1] = data.length & 0xff;
  out.set(data, LENGTH_PREFIX_BYTES);
  return out;
}

/** Reverse of pad(). Validates bucket size, length prefix and zero padding. */
export function unpad(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!BUCKET_SET.has(data.length)) {
    throw new ProtocolError("bad_padding");
  }
  const length = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
  const maxPayload = data.length - LENGTH_PREFIX_BYTES;
  if (length > maxPayload) {
    throw new ProtocolError("bad_padding");
  }
  for (let i = LENGTH_PREFIX_BYTES + length; i < data.length; i++) {
    if (data[i] !== 0) {
      throw new ProtocolError("bad_padding");
    }
  }
  return data.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
}
