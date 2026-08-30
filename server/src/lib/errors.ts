import type { Request, Response, NextFunction, RequestHandler } from 'express';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ValidationIssue {
  code?: string;
  message: string;
}

/** 避免把 Zod 默认的英文类型错误直接暴露给页面。 */
export function formatValidationIssues(issues: ValidationIssue[]): string {
  const detail = issues.map((issue) => {
    let message = issue.message;
    if (issue.code === 'invalid_type' && message.startsWith('Invalid input: expected ')) {
      message = message.endsWith('received undefined') ? '缺少必填参数' : '参数格式不正确';
    }
    return message;
  }).join('; ');
  return detail || '参数校验失败';
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
