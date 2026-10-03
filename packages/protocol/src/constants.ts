/** Constants: sizes, bucket sizes, limits and timeouts (spec sections 5, 6, 7). */

// --- Sizes ---
export const ROOM_ID_BYTES = 8; // base64url -> 11 chars (shortened link, spec §5 updated by request)
export const SECRET_BYTES = 16; // base64url -> 22 chars (128-bit link secret)
export const PEER_ID_BYTES = 16; // base64url -> 22 chars
export const MESSAGE_ID_BYTES = 8; // base64url -> 11 chars
export const AUTH_TOKEN_BYTES = 32; // base64url -> 43 chars
export const IV_BYTES = 12; // AES-GCM nonce
export const GCM_TAG_BYTES = 16; // AES-GCM tag (appended by WebCrypto)

// --- Key derivation ---
export const HKDF_INFO_ENC = "aside-v1-enc"; // -> AES-256-GCM key
export const HKDF_INFO_AUTH = "aside-v1-auth"; // -> 32-byte auth token

// --- Padding ---
export const PAD_BUCKETS = [256, 1024, 4096] as const;
export const MAX_PADDED_BYTES = 4096;
export const LENGTH_PREFIX_BYTES = 2; // big-endian length of the payload

// --- Payload / frame limits ---
export const MAX_TEXT_LENGTH = 1500; // characters
export const MAX_FRAME_BYTES = 8 * 1024; // server frame cap (section 7)
export const LABEL_LENGTH = 4; // random 4-digit labels, distinct per room

// --- Lifecycle timers (section 7) ---
export const WAITING_TIMEOUT_MS = 30 * 60 * 1000; // no second person yet
export const RECONNECT_GRACE_MS = 30 * 1000; // socket dropped -> grace to return
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // no messages
export const MAX_ROOM_AGE_MS = 6 * 60 * 60 * 1000;
export const REAPER_INTERVAL_MS = 10 * 1000;

// --- Server limits (section 7) ---
export const MAX_ROOMS = 5000;
export const MSG_RATE_PER_SECOND = 5;
export const MSG_RATE_BURST = 10;
export const ROOM_CREATE_WINDOW_MS = 60 * 1000;
/** Rooms one IP may create per window. Spec does not fix this number; see README notes. */
export const ROOM_CREATE_LIMIT_PER_IP = 10;
