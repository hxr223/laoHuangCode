export type AttachmentErrorCode = "INVALID_REFERENCE" | "INVALID_IMAGE" | "LIMIT_EXCEEDED" | "NOT_FOUND" | "CORRUPT" | "IO" | "CLOSED" | "ACCESS_DENIED";

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  constructor(code: AttachmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentError";
    this.code = code;
  }
}
