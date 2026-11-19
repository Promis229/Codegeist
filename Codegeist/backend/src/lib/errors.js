import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (m, d) => new AppError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Authentification requise') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'Acces refuse') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Ressource introuvable') => new AppError(404, 'not_found', m);
export const conflict = (m) => new AppError(409, 'conflict', m);

export function errorHandler(err, req, reply) {
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: 'validation_error',
      message: 'Donnees invalides',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.status(err.statusCode).send({ error: err.code ?? 'request_error', message: err.message });
  }
  // 23505 = unique_violation, 22P02 = invalid_text_representation (uuid invalide)
  if (err.code === '23505') return reply.status(409).send({ error: 'conflict', message: 'Cette ressource existe deja' });
  if (err.code === '22P02') return reply.status(400).send({ error: 'bad_request', message: 'Identifiant invalide' });
  req.log.error({ err }, 'unhandled');
  return reply.status(500).send({ error: 'internal_error', message: 'Erreur interne' });
}
