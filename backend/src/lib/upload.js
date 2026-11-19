import net from 'node:net';
import { AppError, badRequest } from './errors.js';

/**
 * Sécurité des fichiers envoyés (pièces jointes de la messagerie, photos de profil).
 * Principe : on ne fait confiance ni au nom, ni au type annoncé par le client. Le type vient du CONTENU, la liste des formats est
 * fermée, tout contenu actif est refusé, et à la lecture les fichiers sont servis isolés (voir chat.js : nosniff + CSP sandbox).
 *
 *  1. liste blanche de formats reconnus par leurs octets magiques (images raster, PDF, Office, zip, texte) ; SVG et HTML exclus
 *  2. exécutables et scripts refusés quel que soit leur nom (PE/MZ, ELF, Mach-O, shebang, balises <script>/<html>…)
 *  3. PDF : refus des PDF à contenu actif (JavaScript, lancement de programme, action à l'ouverture, fichier embarqué)
 *  4. Office / zip : refus des macros (vbaProject.bin), des ActiveX et des archives contenant un exécutable
 *  5. CSV : refus des cellules qui commenceraient une formule (injection de formules dans Excel)
 *  6. images : dimensions plafonnées pour les PNG (bombe de décompression) ; GIF/JPEG/WebP servis avec nosniff + sandbox
 *  7. nom de fichier assaini (pas de chemin, de caractères de contrôle ni d'inversion bidirectionnelle) et extension alignée sur le type
 *  8. antivirus ClamAV en option (CLAMD_HOST) : s'il est configuré et injoignable, l'envoi est refusé (échec fermé)
 */
const OOXML = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EXT = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'], 'application/pdf': ['pdf'],
  'application/zip': ['zip'], 'text/csv': ['csv'], 'text/plain': ['txt', 'log', 'md'], ...Object.fromEntries(Object.entries(OOXML).map(([e, m]) => [m, [e]])),
};
const MAX_PNG_SIDE = 12000;

const at = (buf, i, s) => buf.length >= i + s.length && buf.subarray(i, i + s.length).toString('latin1') === s;

/** Type réel d'après les octets magiques ; null si le format n'est pas dans la liste blanche. */
export function sniffFile(buf, name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  if (buf.length > 8 && buf[0] === 0x89 && at(buf, 1, 'PNG')) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (at(buf, 0, 'GIF87a') || at(buf, 0, 'GIF89a')) return 'image/gif';
  if (at(buf, 0, 'RIFF') && at(buf, 8, 'WEBP')) return 'image/webp';
  if (at(buf, 0, '%PDF-')) return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return OOXML[ext] ?? 'application/zip';
  if (['txt', 'csv', 'log', 'md'].includes(ext) && !buf.subarray(0, 4096).includes(0)) return ext === 'csv' ? 'text/csv' : 'text/plain';
  return null;
}

const EXECUTABLE = [
  (b) => b[0] === 0x4d && b[1] === 0x5a,                                   // PE (Windows .exe/.dll)
  (b) => b[0] === 0x7f && at(b, 1, 'ELF'),                                 // ELF (Linux)
  (b) => [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe, 0xcefaedfe].includes(b.length >= 4 ? b.readUInt32BE(0) : 0), // Mach-O / classe Java
  (b) => b[0] === 0x23 && b[1] === 0x21,                                   // #! script
];
const ACTIVE_TEXT = /<\s*(script|html|iframe|object|embed|svg|body|meta|link|style)\b|javascript\s*:|\bon(error|load|click)\s*=/i;
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|XFA|SubmitForm|GoToR)\b/;
const ZIP_BAD_ENTRY = /\.(exe|dll|bat|cmd|com|scr|msi|ps1|vbs|vbe|js|jse|jar|lnk|hta|cpl|reg|sh|apk)(?![A-Za-z0-9])/i;

function pngSize(buf) {
  if (!at(buf, 12, 'IHDR') || buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Assainit le nom : pas de chemin, de caractères de contrôle ni d'inversion de sens (RLO), et une extension cohérente avec le contenu. */
export function safeName(raw, mime) {
  let n = String(raw).normalize('NFC').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"<>|:*?‪-‮⁦-⁩​-‏]/g, '').trim();
  n = n.replace(/^\.+/, '').slice(-150) || 'fichier';
  const allowed = EXT[mime] ?? [];
  const m = n.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!m || !allowed.includes(m[1].toLowerCase())) n = `${m ? n.slice(0, -m[0].length) : n}.${allowed[0] ?? 'bin'}`; // « photo.exe » contenant un PNG devient « photo.png »
  // Plusieurs extensions successives (facture.pdf.exe) : seul le dernier point est conservé comme extension.
  return n.replace(/\.(?=[^.]*\.[^.]+$)/g, '_');
}

/**
 * Vérifie un fichier et renvoie { mime, name } ; lève une erreur 400 explicite sinon.
 * `only` restreint les types acceptés (ex. images pour une photo de profil).
 */
export function inspectFile(buf, rawName, { only = null } = {}) {
  if (!buf.length) throw badRequest('Fichier vide');
  if (EXECUTABLE.some((f) => f(buf))) throw badRequest('Fichier exécutable refusé');
  const mime = sniffFile(buf, rawName);
  if (!mime) throw badRequest('Type de fichier non autorisé (images, PDF, documents Office, zip, texte et CSV uniquement)');
  if (only && !only.has(mime)) throw badRequest('Ce type de fichier n\'est pas accepté ici');

  const head = buf.subarray(0, 16384).toString('latin1');
  if (IMAGE_MIMES.has(mime)) {
    if (ACTIVE_TEXT.test(head)) throw badRequest('Image refusée : contenu actif détecté'); // polyglotte image/HTML
    if (mime === 'image/png') {
      const d = pngSize(buf);
      if (!d || d.w < 1 || d.h < 1 || d.w > MAX_PNG_SIDE || d.h > MAX_PNG_SIDE) throw badRequest('Image PNG invalide ou démesurée');
    }
  } else if (mime === 'application/pdf') {
    if (PDF_ACTIVE.test(buf.toString('latin1'))) throw badRequest('PDF refusé : il contient du contenu actif (JavaScript, lancement de programme ou fichier embarqué)');
  } else if (mime === 'application/zip' || mime.startsWith('application/vnd.openxmlformats')) {
    const s = buf.toString('latin1');
    if (/vbaProject\.bin|activeX\d*\.(xml|bin)|\.docm|\.xlsm|\.pptm/i.test(s)) throw badRequest('Document refusé : il contient des macros ou des contrôles ActiveX');
    if (ZIP_BAD_ENTRY.test(s)) throw badRequest('Archive refusée : elle contient un programme ou un script');
  } else if (mime === 'text/csv') {
    const t = buf.toString('utf8');
    if (/(^|[,;\t\r\n])\s*["']?(=|@|[+-][A-Za-z(@])/.test(t)) throw badRequest('CSV refusé : une cellule commence par une formule (=, +, -, @)');
  } else if (mime === 'text/plain' && ACTIVE_TEXT.test(head)) {
    throw badRequest('Texte refusé : contenu actif détecté');
  }
  return { mime, name: safeName(rawName, mime) };
}

/**
 * Analyse antivirus ClamAV (protocole INSTREAM de clamd). Facultative : sans CLAMD_HOST, aucune analyse n'est faite.
 * Configurée mais injoignable : on refuse l'envoi plutôt que d'accepter un fichier non analysé.
 */
export async function scanFile(buf) {
  const host = process.env.CLAMD_HOST;
  if (!host) return;
  const port = Number(process.env.CLAMD_PORT || 3310);
  const verdict = await new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let out = '';
    sock.setTimeout(15_000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
    sock.on('data', (d) => { out += d.toString('utf8'); });
    sock.on('end', () => resolve(out.replace(/\0/g, '').trim()));
    sock.write('zINSTREAM\0');
    for (let i = 0; i < buf.length; i += 65536) {
      const chunk = buf.subarray(i, i + 65536);
      const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
      sock.write(len); sock.write(chunk);
    }
    sock.end(Buffer.alloc(4)); // fin du flux : longueur 0
  }).catch(() => null);
  if (verdict === null) throw new AppError(503, 'scan_unavailable', 'Analyse antivirus indisponible : fichier refusé par précaution');
  if (/FOUND$/.test(verdict)) throw badRequest('Fichier refusé : l\'antivirus a détecté une menace');
  if (!/OK$/.test(verdict)) throw new AppError(503, 'scan_unavailable', 'Analyse antivirus indisponible : fichier refusé par précaution');
}
