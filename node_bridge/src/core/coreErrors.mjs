export class CoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CoreError';
    this.code = code;
  }
}

export function coreError(code, message, cause) {
  return new CoreError(code, message, cause ? { cause } : {});
}
