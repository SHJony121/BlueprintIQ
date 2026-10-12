// Limits shared by the browser (early file checks) and the server-side proxy, so the
// two cannot drift apart. They mirror the backend's defaults (max_upload_bytes).
export const MIB = 1024 * 1024;

/** Largest upload accepted: 10 MiB, exactly 10,485,760 bytes. */
export const MAX_UPLOAD_BYTES = 10 * MIB;
