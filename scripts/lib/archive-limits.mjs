// The measured lossless site ZIP is ~325 MB. Extraction remains capped at
// 450 MiB and each published asset at 25 MiB; only the packed ZIP limit changes.
export const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;
