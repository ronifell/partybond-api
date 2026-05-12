export class HttpError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'Bad request', code = 'bad_request', details?: unknown) {
    return new HttpError(400, message, code, details);
  }
  static unauthorized(message = 'Unauthorized', code = 'unauthorized') {
    return new HttpError(401, message, code);
  }
  static forbidden(message = 'Forbidden', code = 'forbidden') {
    return new HttpError(403, message, code);
  }
  static notFound(message = 'Not found', code = 'not_found') {
    return new HttpError(404, message, code);
  }
  static conflict(message = 'Conflict', code = 'conflict') {
    return new HttpError(409, message, code);
  }
}
