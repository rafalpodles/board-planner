// The name a deleted account is left under in stored text. Kept apart from the server-only erasure
// so the client can recognise it.
const LABEL_PATTERN = /^deleted-[0-9a-f]{8}$/;

export const isErasedLabel = (value: string): boolean => LABEL_PATTERN.test(value);
