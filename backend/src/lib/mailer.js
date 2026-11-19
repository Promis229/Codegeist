import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Envoi d'e-mail.
 *  - test            : conserve dans `outbox` (verifie par les tests)
 *  - SMTP_URL defini : envoi reel (ex. smtps://user:pass@smtp.example.com:465), expediteur MAIL_FROM
 *  - sinon, hors prod: le message complet est ecrit dans la console (le code a 6 chiffres y est lisible)
 *  - sinon, en prod  : ECHEC EXPLICITE (503 email_unavailable). On ne pretend jamais qu'un code est parti alors que rien ne l'est :
 *                      l'utilisateur voit l'erreur au lieu d'attendre un e-mail qui ne viendra pas.
 * Les echecs SMTP (identifiants refuses, serveur injoignable) donnent la meme erreur ; le detail est journalise cote serveur,
 * sans jamais ecrire le contenu du message (il contient des codes et des liens secrets).
 */
export const outbox = [];

let transport;
const smtp = () => (transport ??= nodemailer.createTransport(process.env.SMTP_URL));
export const mailConfigured = () => env.isTest || !!process.env.SMTP_URL || !env.isProd;

export async function sendMail({ to, subject, text }) {
  if (env.isTest) { outbox.push({ to, subject, text }); return; }
  if (process.env.SMTP_URL) {
    try {
      const info = await smtp().sendMail({ from: process.env.MAIL_FROM || 'Kairos <no-reply@localhost>', to, subject, text });
      if (!info.accepted?.length) throw new Error(`destinataire refuse : ${(info.rejected ?? []).join(',')}`);
    } catch (e) {
      console.error(`[mail] echec d'envoi a ${to} (${subject}) : ${e.message}`);
      throw new AppError(503, 'email_unavailable', "L'envoi de l'e-mail a echoue");
    }
    return;
  }
  if (!env.isProd) { console.log(`\n[mail:dev] a: ${to}\n[mail:dev] objet: ${subject}\n${text}\n`); return; }
  console.error(`[mail] SMTP_URL non configure : impossible d'envoyer "${subject}" a ${to}`);
  throw new AppError(503, 'email_unavailable', "L'envoi d'e-mails n'est pas configure sur ce serveur");
}
