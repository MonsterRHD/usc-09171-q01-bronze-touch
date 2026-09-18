// 统一错误类型：HTTP 状态码 + 机器可读错误码 + 中文说明。
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (code, message, details) => new ApiError(401, code, message, details);
export const forbidden = (code, message, details) => new ApiError(403, code, message, details);
export const notFound = (code, message, details) => new ApiError(404, code, message, details);
export const conflict = (code, message, details) => new ApiError(409, code, message, details);
export const unprocessable = (code, message, details) => new ApiError(422, code, message, details);
