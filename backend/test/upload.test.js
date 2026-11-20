import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.CLAMD_HOST; // pas d'antivirus dans ces tests : on vérifie les contrôles intégrés
const { buildApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seedDemo, resetDemo, DEMO } = await import('../src/db/seed.js');
const { pool } = await import('../src/db/pool.js');
const { outbox } = await import('../src/lib/mailer.js');
const { sniffFile, inspectFile, safeName } = await import('../src/lib/upload.js');

let app;
const rid = Math.random().toString(36).slice(2, 8);
const call = async (method, url, token, body) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json; try { json = res.json(); } catch { json = null; }
  return { status: res.statusCode, body: json, raw: res };
};
const login = async (email) => (await call('POST', '/auth/login', null, { email, password: DEMO.password })).body.accessToken;
const b64 = (b) => Buffer.from(b).toString('base64');

// Fichiers de test : un PNG valide (1x1), et des fichiers hostiles ou douteux.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(64, 1)]);
const PDF_OK = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const PDF_JS = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\n%%EOF');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 7)]);
const ELF = Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(100)]);
const zip = (names) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(names.join('\0') + '\0', 'latin1'), Buffer.alloc(32)]);

let alice, bruno, chen, outsider, general, incidents;
before(async () => {
  await migrate(() => {});
  await resetDemo(); await seedDemo(() => {});
  app = await buildApp({ logger: false }); await app.ready();
  alice = await login(DEMO.email); bruno = await login('bruno@kairos.dev'); chen = await login('chen@kairos.dev');
  const email = `up-out-${rid}@example.com`;
  await call('POST', '/auth/register', null, { email, password: 'Str0ng-Passphrase!', acceptTerms: true, acceptPrivacy: true, displayName: 'Outsider', orgName: `Out ${rid}` });
  const code = [...outbox].reverse().find((m) => m.to === email).text.match(/\b(\d{6})\b/)[1];
  outsider = (await call('POST', '/auth/verify-email', null, { email, code })).body.accessToken;
  const list = (await call('GET', '/chat/channels', bruno)).body.channels;
  general = list.find((c) => c.name === 'general'); incidents = list.find((c) => c.name === 'incidents');
});
after(async () => { await app.close(); await pool.end(); });

const send = (token, channel, body) => call('POST', `/chat/channels/${channel.id}/messages`, token, body);
const file = (name, buf) => ({ name, data: b64(buf) });

describe('Contrôle des fichiers : le type vient du contenu, pas du nom', () => {
  it('reconnaît les formats autorisés par leurs octets magiques', () => {
    assert.equal(sniffFile(PNG, 'a.png'), 'image/png');
    assert.equal(sniffFile(JPEG, 'a.jpg'), 'image/jpeg');
    assert.equal(sniffFile(PDF_OK, 'a.pdf'), 'application/pdf');
    assert.equal(sniffFile(Buffer.from('a,b\n1,2\n'), 'a.csv'), 'text/csv');
    assert.equal(sniffFile(zip(['word/document.xml']), 'a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
  it('refuse un script déguisé en image, le SVG et le HTML', () => {
    for (const [name, buf] of [['x.png', Buffer.from('<script>alert(1)</script>')], ['x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')], ['x.html', Buffer.from('<html><script>1</script></html>')], ['x.js', Buffer.from('alert(1)')]]) {
      assert.throws(() => inspectFile(buf, name), /autorisé|actif/, name);
    }
  });
  it('refuse les exécutables, quel que soit leur nom', () => {
    assert.throws(() => inspectFile(EXE, 'photo.png'), /exécutable/);
    assert.throws(() => inspectFile(ELF, 'doc.pdf'), /exécutable/);
    assert.throws(() => inspectFile(Buffer.from('#!/bin/sh\nrm -rf /\n'), 'notes.txt'), /exécutable/);
  });
  it('refuse les images polyglottes (image + HTML) et les PNG démesurés', () => {
    assert.throws(() => inspectFile(Buffer.concat([Buffer.from('GIF89a'), Buffer.from('<script>alert(1)</script>')]), 'a.gif'), /actif/);
    const huge = Buffer.from(PNG); huge.writeUInt32BE(60000, 16);
    assert.throws(() => inspectFile(huge, 'a.png'), /démesurée|invalide/);
  });
  it('refuse les PDF à contenu actif mais accepte un PDF simple', () => {
    assert.throws(() => inspectFile(PDF_JS, 'a.pdf'), /contenu actif/);
    assert.equal(inspectFile(PDF_OK, 'a.pdf').mime, 'application/pdf');
  });
  it('refuse les macros Office et les archives contenant un programme', () => {
    assert.throws(() => inspectFile(zip(['word/vbaProject.bin']), 'a.docx'), /macros/);
    assert.throws(() => inspectFile(zip(['docs/readme.txt', 'setup.exe']), 'a.zip'), /programme/);
    assert.equal(inspectFile(zip(['docs/readme.txt']), 'a.zip').mime, 'application/zip');
  });
  it('refuse les CSV qui commencent une formule, accepte un CSV normal (même avec des nombres négatifs)', () => {
    assert.throws(() => inspectFile(Buffer.from('nom,total\nx,=cmd|\' /c calc\'!A1\n'), 'a.csv'), /formule/);
    assert.throws(() => inspectFile(Buffer.from('a\n@SUM(1+1)\n'), 'a.csv'), /formule/);
    assert.equal(inspectFile(Buffer.from('jour,delta\nlundi,-5\nmardi,12\n'), 'a.csv').mime, 'text/csv');
  });
  it('assainit le nom : pas de chemin, pas d\'inversion de sens, extension alignée sur le contenu', () => {
    assert.equal(safeName('photo.exe', 'image/png'), 'photo.png');
    assert.equal(safeName('facture.pdf.exe', 'application/pdf'), 'facture_pdf.pdf');
    assert.ok(!/[\\/]/.test(safeName('../../etc/passwd.png', 'image/png')));
    assert.ok(!/[‮‭]/.test(safeName('fa‮txt.png', 'image/png')));
    assert.ok(safeName('.htaccess', 'image/png').endsWith('.png'));
  });
});

describe('Messagerie : pièces jointes', () => {
  let withFile;
  it('envoie une image et un PDF, avec le type et le nom réels', async () => {
    const r = await send(bruno, general, { body: 'Capture et rapport', attachments: [file('capture.exe', PNG), file('rapport.pdf', PDF_OK)] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attachments.length, 2);
    assert.deepEqual(r.body.attachments.map((a) => a.mime), ['image/png', 'application/pdf']);
    assert.equal(r.body.attachments[0].name, 'capture.png', 'extension corrigée d\'après le contenu');
    withFile = r.body;
  });
  it('accepte un message composé uniquement de pièces jointes, refuse un message totalement vide', async () => {
    assert.equal((await send(bruno, general, { attachments: [file('a.png', PNG)] })).status, 201);
    assert.equal((await send(bruno, general, { body: '  ' })).status, 400);
  });
  it('refuse les fichiers dangereux à l\'envoi', async () => {
    for (const f of [file('a.png', EXE), file('virus.js', Buffer.from('alert(1)')), file('a.pdf', PDF_JS), file('a.svg', Buffer.from('<svg onload="alert(1)"/>')), file('a.docx', zip(['word/vbaProject.bin']))]) {
      const r = await send(bruno, general, { attachments: [f] });
      assert.equal(r.status, 400, `${f.name} aurait dû être refusé`);
    }
    const msgs = (await call('GET', `/chat/channels/${general.id}/messages`, bruno)).body.messages;
    assert.ok(!msgs.some((m) => m.attachments.some((a) => /virus|a\.svg/.test(a.name))), 'rien n\'a été enregistré');
  });
  it('limite le nombre et la taille', async () => {
    assert.equal((await send(bruno, general, { attachments: Array.from({ length: 5 }, (_, i) => file(`${i}.png`, PNG)) })).status, 400);
    const big = Buffer.concat([PNG.subarray(0, 24), Buffer.alloc(3 * 1024 * 1024 + 10, 1)]);
    assert.equal((await send(bruno, general, { attachments: [file('big.png', big)] })).status, 400);
  });
  it('sert les images en ligne et le reste en téléchargement, isolés (nosniff, CSP sandbox)', async () => {
    const [img, pdf] = withFile.attachments;
    const i = await call('GET', `/chat/attachments/${img.id}`, chen);
    assert.equal(i.status, 200);
    assert.equal(i.raw.headers['content-type'], 'image/png');
    assert.match(i.raw.headers['content-disposition'], /^inline/);
    assert.equal(i.raw.headers['x-content-type-options'], 'nosniff');
    assert.match(i.raw.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(i.raw.rawPayload, PNG);
    const p = await call('GET', `/chat/attachments/${pdf.id}`, chen);
    assert.match(p.raw.headers['content-disposition'], /^attachment/);
  });
  it('les fichiers ne sont lisibles que par les membres de la conversation', async () => {
    const att = withFile.attachments[0];
    assert.equal((await call('GET', `/chat/attachments/${att.id}`, outsider)).status, 404, 'autre organisation');
    assert.equal((await call('GET', `/chat/attachments/${att.id}`)).status, 401, 'sans connexion');
    // Pièce jointe d'un message direct : invisible pour un tiers de la même organisation.
    const members = (await call('GET', '/members', alice)).body.members;
    const dm = (await call('POST', '/chat/dm', chen, { userId: members.find((m) => m.email === 'dana@kairos.dev').id })).body;
    const secret = (await send(chen, dm, { attachments: [file('prive.png', PNG)] })).body.attachments[0];
    assert.equal((await call('GET', `/chat/attachments/${secret.id}`, bruno)).status, 404);
    assert.equal((await call('GET', `/chat/attachments/${secret.id}`, chen)).status, 200);
  });
  it('supprimer le message supprime ses fichiers', async () => {
    const m = (await send(bruno, general, { attachments: [file('a.png', PNG)] })).body;
    assert.equal((await call('DELETE', `/chat/messages/${m.id}`, bruno)).status, 200);
    assert.equal((await call('GET', `/chat/attachments/${m.attachments[0].id}`, bruno)).status, 404);
  });
});

describe('Messagerie : répondre à un message précis', () => {
  it('cite le message d\'origine avec son auteur et un extrait', async () => {
    const orig = (await send(bruno, general, { body: 'Le déploiement de 14 h est reporté à demain matin, tout le monde est prévenu.' })).body;
    const rep = await send(chen, general, { body: 'Merci, je préviens le client.', replyTo: orig.id });
    assert.equal(rep.status, 201);
    assert.equal(rep.body.replyTo.id, orig.id);
    assert.equal(rep.body.replyTo.authorName, 'Bruno Leroy');
    assert.match(rep.body.replyTo.body, /déploiement de 14 h/);
    const list = (await call('GET', `/chat/channels/${general.id}/messages?after=${orig.id - 1}`, alice)).body.messages;
    assert.equal(list.find((m) => m.id === rep.body.id).replyTo.id, orig.id, 'la citation survit au rechargement');
  });
  it('refuse de citer un message d\'une autre conversation ou inexistant', async () => {
    const other = (await send(bruno, incidents, { body: 'Message ailleurs' })).body;
    assert.equal((await send(chen, general, { body: 'x', replyTo: other.id })).status, 400);
    assert.equal((await send(chen, general, { body: 'x', replyTo: 999999999 })).status, 400);
  });
  it('si le message d\'origine est supprimé, la réponse reste sans citation', async () => {
    const orig = (await send(bruno, general, { body: 'À supprimer' })).body;
    const rep = (await send(chen, general, { body: 'Réponse', replyTo: orig.id })).body;
    await call('DELETE', `/chat/messages/${orig.id}`, bruno);
    const after = (await call('GET', `/chat/channels/${general.id}/messages?after=${rep.id - 1}`, chen)).body.messages.find((m) => m.id === rep.id);
    assert.equal(after.replyTo, null);
    assert.equal(after.body, 'Réponse');
  });
  it('la démo contient une vraie réponse citée', async () => {
    const msgs = (await call('GET', `/chat/channels/${incidents.id}/messages`, bruno)).body.messages;
    const quoted = msgs.find((m) => m.replyTo);
    assert.ok(quoted && quoted.replyTo.authorName === 'Bruno Leroy');
  });
});

describe('Photo de profil', () => {
  it('téléverse une photo, la relit, et la propose aux collègues', async () => {
    const r = await call('PUT', '/me/avatar', chen, { data: b64(PNG) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.avatarUrl, /^\/users\/[0-9a-f-]{36}\/avatar\?v=\d+$/);
    const path = r.body.avatarUrl.replace(/\?.*/, '');
    const self = await call('GET', path, chen);
    assert.equal(self.status, 200); assert.equal(self.raw.headers['content-type'], 'image/png');
    assert.equal(self.raw.headers['x-content-type-options'], 'nosniff');
    assert.equal((await call('GET', path, bruno)).status, 200, 'collègue de la même organisation');
    assert.equal((await call('GET', path, outsider)).status, 404, 'jamais publique');
    assert.equal((await call('GET', path)).status, 401);
    const members = (await call('GET', '/members', bruno)).body.members;
    assert.ok(members.find((m) => m.email === 'chen@kairos.dev').avatar_url.includes('/avatar?v='));
    const me = await call('GET', '/auth/me', chen);
    assert.equal(me.body.user.avatarUrl, r.body.avatarUrl);
  });
  it('refuse tout ce qui n\'est pas une image raster sûre', async () => {
    for (const buf of [PDF_OK, EXE, Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('<script>1</script>'), zip(['a.txt'])]) {
      assert.equal((await call('PUT', '/me/avatar', chen, { data: b64(buf) })).status, 400);
    }
    assert.equal((await call('PUT', '/me/avatar', chen, { data: b64(Buffer.concat([PNG.subarray(0, 24), Buffer.alloc(700 * 1024, 1)])) })).status, 400, 'trop lourde');
  });
  it('supprime la photo', async () => {
    assert.equal((await call('DELETE', '/me/avatar', chen)).status, 200);
    assert.equal((await call('GET', '/auth/me', chen)).body.user.avatarUrl, null);
  });
});
