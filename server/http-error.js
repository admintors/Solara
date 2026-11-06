'use strict';

class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
function fail(res, error, requestId = null) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const body = { error: {
    code: error.code || 'INTERNAL_ERROR',
    message: status >= 500 && !error.code ? '服务暂时不可用' : (error.message || '请求失败'),
    requestId: requestId || null,
  } };
  if (error.details) body.error.details = error.details;
  if (status >= 500) console.error('[request error]', requestId || '-', error.code || error.name || 'ERROR');
  return res.status(status).set('Cache-Control', 'no-store').json(body);
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
module.exports = { HttpError, fail, asyncRoute };
