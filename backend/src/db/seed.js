import { hashPassword } from '../auth/password.js';
import { pool, tx } from './pool.js';
import { detectLang, frustration, minhash, sentiment } from '../lib/text.js';
import { encrypt } from '../lib/crypto.js';

export const DEMO = { email: 'demo@kairos.dev', password: 'Kairos-Demo-2026!', orgSlug: 'acme' };

// PRNG deterministe : meme jeu de donnees a chaque installation.
function rng(seed = 7) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

const KB = [
  ['Reinitialiser son mot de passe', "Pour reinitialiser votre mot de passe, ouvrez la page de connexion et cliquez sur Mot de passe oublie. Saisissez votre adresse email. Vous recevrez un lien valable 30 minutes. Si le lien a expire, demandez-en un nouveau."],
  ['Limites de debit de l\'API (429)', "L'API applique une limite de 600 requetes par minute et par cle. Au-dela, la reponse est 429 Too Many Requests avec l'en-tete Retry-After. Pour les exports volumineux, utilisez l'endpoint bulk avec pagination par curseur et attendez la valeur Retry-After avant de reessayer."],
  ['Exporter les factures en CSV', "Dans Facturation, ouvrez l'onglet Factures puis cliquez sur Exporter. Choisissez la periode et le format CSV. Les montants sont indiques hors taxes, la TVA figure dans une colonne separee."],
  ['Configurer les webhooks', "Creez un webhook dans Parametres, Integrations. Verifiez la signature avec le secret fourni et rejetez les requetes dont l'horodatage depasse cinq minutes. Les livraisons echouees sont retentees avec un delai croissant."],
  ['Erreur de paiement a la caisse', "Une erreur 502 a la caisse indique en general un incident du fournisseur de paiement. Verifiez la page de statut, videz le panier et reessayez. Si le probleme persiste, contactez le support avec l'identifiant de transaction."],
  ['Application mobile : plantage au demarrage', "Si l'application se ferme au lancement, mettez-la a jour vers la derniere version, redemarrez l'appareil puis reinstallez l'application. Les donnees sont synchronisees avec votre compte."],
];

// Le contenu de demonstration existe dans les trois langues de l'interface : un visiteur anglophone ne doit pas lire du francais.
// Memes articles que KB, dans le meme ordre (les indices sont utilises plus bas).
const KB_EN = [
  ['Reset your password', "To reset your password, open the sign-in page and click Forgot password. Enter your email address. You will receive a link valid for 30 minutes. If the link has expired, request a new one."],
  ['API rate limits (429)', "The API enforces a limit of 600 requests per minute per key. Beyond that, the response is 429 Too Many Requests with a Retry-After header. For large exports, use the bulk endpoint with cursor pagination and wait for the Retry-After value before retrying."],
  ['Export invoices to CSV', "In Billing, open the Invoices tab and click Export. Choose the period and the CSV format. Amounts are shown excluding tax, VAT appears in a separate column."],
  ['Configure webhooks', "Create a webhook in Settings, Integrations. Verify the signature with the provided secret and reject requests whose timestamp is older than five minutes. Failed deliveries are retried with an increasing delay."],
  ['Payment error at checkout', "A 502 error at checkout usually means an incident at the payment provider. Check the status page, empty the cart and try again. If the problem persists, contact support with the transaction identifier."],
  ['Mobile app: crash on launch', "If the app closes at launch, update it to the latest version, restart the device, then reinstall the app. Your data is synchronised with your account."],
];
const KB_ES = [
  ['Restablecer la contraseña', "Para restablecer su contraseña, abra la página de inicio de sesión y haga clic en Olvidé mi contraseña. Introduzca su dirección de correo. Recibirá un enlace válido durante 30 minutos. Si el enlace ha caducado, solicite uno nuevo."],
  ['Límites de tasa de la API (429)', "La API aplica un límite de 600 solicitudes por minuto y por clave. Más allá, la respuesta es 429 Too Many Requests con la cabecera Retry-After. Para exportaciones voluminosas, use el endpoint bulk con paginación por cursor y espere el valor de Retry-After antes de reintentar."],
  ['Exportar las facturas a CSV', "En Facturación, abra la pestaña Facturas y haga clic en Exportar. Elija el periodo y el formato CSV. Los importes se indican sin impuestos; el IVA figura en una columna aparte."],
  ['Configurar los webhooks', "Cree un webhook en Ajustes, Integraciones. Verifique la firma con el secreto proporcionado y rechace las solicitudes cuya marca de tiempo supere los cinco minutos. Las entregas fallidas se reintentan con un retraso creciente."],
  ['Error de pago en la caja', "Un error 502 en la caja suele indicar una incidencia del proveedor de pago. Compruebe la página de estado, vacíe el carrito y vuelva a intentarlo. Si el problema persiste, contacte con el soporte indicando el identificador de la transacción."],
  ['Aplicación móvil: se cierra al abrir', "Si la aplicación se cierra al abrirse, actualícela a la última versión, reinicie el dispositivo y vuelva a instalarla. Sus datos están sincronizados con su cuenta."],
];

const T = {
  checkout: [
    ['Payment fails at checkout with error 502', "Customers cannot complete payment, the checkout returns a 502 error. This started a few hours ago. Please investigate, we are losing orders."],
    ['Erreur 502 lors du paiement', "Impossible de finaliser les commandes, la caisse affiche une erreur 502 depuis ce matin. Nous perdons des ventes, c'est urgent."],
    ['Checkout stuck on loading spinner', "The checkout page never finishes loading after we click Pay. Tried three browsers, same result."],
  ],
  sso: [
    ['SAML login loops back to sign-in page', "After authenticating with our identity provider, users are redirected back to the sign-in page. Our SAML metadata certificate was rotated yesterday."],
    ['Rotation du certificat SAML', "Nous avons change le certificat de signature SAML de notre IdP et plus personne ne peut se connecter. Quelle est la procedure pour mettre a jour les metadonnees ?"],
    ['SSO metadata certificate expired', "Our SAML metadata certificate expired and SSO is down for the whole company. How do we upload the new metadata file?"],
  ],
  api: [
    ['429 Too Many Requests on bulk export', "Our nightly export job gets 429 errors from the bulk endpoint after a few thousand requests. How should we handle the rate limit?"],
    ['Limite de debit API depassee', "Notre integration recoit des erreurs 429. Comment augmenter la limite ou paginer correctement les exports ?"],
  ],
  billing: [
    ['Invoice shows wrong VAT amount', "The VAT on our last invoice looks incorrect, it should be 20 percent not 10 percent. Can you reissue it?"],
    ['Export des factures impossible', "Le bouton Exporter reste grise dans la page Factures, je veux un CSV pour la comptabilite."],
  ],
  mobile: [
    ['App crashes on launch after update', "Since the latest update the mobile app closes immediately when I open it. Reinstalling did not help."],
    ['Plantage de l\'application au demarrage', "L'application mobile se ferme des l'ouverture depuis la derniere mise a jour."],
  ],
  webhooks: [
    ['Webhook deliveries are delayed', "We see webhook events arriving 20 minutes late. Is there an incident on your side?"],
    ['Signature de webhook invalide', "Notre serveur rejette vos webhooks, la verification de signature echoue systematiquement."],
  ],
  account: [
    ['Cannot reset my password', "The reset link in the email says it has expired immediately. I tried twice."],
    ['Mot de passe oublie : lien expire', "Le lien de reinitialisation recu par email est deja expire quand je clique dessus."],
  ],
};

// Demandes en espagnol (une par composant) : ajoutees a T, donc tirees comme les autres.
const T_ES = {
  checkout: [['El pago falla en la caja con error 502', "Los clientes no pueden completar el pago, la caja muestra un error 502 desde esta mañana. Estamos perdiendo pedidos, es urgente."]],
  sso: [['Bucle en el inicio de sesión SAML', "Tras autenticarnos con nuestro proveedor de identidad, los usuarios vuelven a la página de inicio de sesión. Rotamos el certificado SAML ayer."]],
  api: [['Error 429 por límite de tasa en la exportación masiva', "Nuestro trabajo nocturno de exportación recibe errores 429 del endpoint bulk. ¿Cómo debemos gestionar el límite de tasa?"]],
  billing: [['La factura muestra un IVA incorrecto', "El IVA de nuestra última factura parece incorrecto, debería ser del 20 por ciento y no del 10. ¿Pueden emitirla de nuevo?"]],
  mobile: [['La aplicación se cierra al abrir tras actualizar', "Desde la última actualización la aplicación móvil se cierra nada más abrirla. Reinstalarla no ayudó."]],
  webhooks: [['Las entregas de webhooks llegan con retraso', "Vemos eventos de webhook que llegan con 20 minutos de retraso. ¿Hay una incidencia por su parte?"]],
  account: [['No puedo restablecer mi contraseña', "El enlace de restablecimiento del correo dice que ya ha caducado. Lo intenté dos veces."]],
};
for (const [c, rows] of Object.entries(T_ES)) T[c].push(...rows);

// Le fil d'une demande reste dans UNE langue : l'agent repond dans la langue du client (detectee sur le texte de la demande).
const REPLIES = {
  fr: {
    checkout: ["Bonjour, nous avons identifie un incident chez notre fournisseur de paiement. Une correction est en cours. Merci de reessayer dans une heure. Cordialement."],
    sso: ["Bonjour, ouvrez Parametres, Securite, SSO puis importez le nouveau fichier de metadonnees SAML. Verifiez que le certificat est au format PEM avant de valider. Cordialement."],
    api: ["Bonjour, la limite est de 600 requetes par minute. Respectez l'en-tete Retry-After et utilisez la pagination par curseur sur l'endpoint bulk. Cordialement."],
    billing: ["Bonjour, nous avons reemis la facture avec le bon taux de TVA. Elle est disponible dans l'onglet Factures. Cordialement."],
    mobile: ["Bonjour, mettez a jour l'application vers la version 4.2.1 puis redemarrez votre appareil. Le correctif de plantage est inclus. Cordialement."],
    webhooks: ["Bonjour, un retard de livraison a ete corrige. Les evenements en file ont ete rejoues automatiquement. Cordialement."],
    account: ["Bonjour, un nouveau lien valable 30 minutes vous a ete envoye. Verifiez vos courriers indesirables. Cordialement."],
  },
  en: {
    checkout: ["Hello, we identified an incident at our payment provider. A fix is in progress. Please try again in an hour. Kind regards."],
    sso: ["Hello, please upload the new SAML metadata in Settings, Security, SSO. Check that the certificate is in PEM format before saving. Kind regards."],
    api: ["Hello, the limit is 600 requests per minute. Please honour the Retry-After header and use cursor pagination on the bulk endpoint. Kind regards."],
    billing: ["Hello, we have reissued the invoice with the correct VAT rate. It is available in the Invoices tab. Kind regards."],
    mobile: ["Hello, please update the app to version 4.2.1 and restart your device. The crash fix is included. Kind regards."],
    webhooks: ["Hello, a delivery delay has been fixed. Queued events were replayed automatically. Kind regards."],
    account: ["Hello, a new link valid for 30 minutes has been sent to you. Please check your spam folder. Kind regards."],
  },
  es: {
    checkout: ["Hola, hemos identificado una incidencia en nuestro proveedor de pago. Se está corrigiendo. Por favor, inténtelo de nuevo dentro de una hora. Saludos cordiales."],
    sso: ["Hola, suba los nuevos metadatos SAML en Ajustes, Seguridad, SSO. Compruebe que el certificado está en formato PEM antes de guardar. Saludos cordiales."],
    api: ["Hola, el límite es de 600 solicitudes por minuto. Respete la cabecera Retry-After y use la paginación por cursor en el endpoint bulk. Saludos cordiales."],
    billing: ["Hola, hemos vuelto a emitir la factura con el tipo de IVA correcto. Está disponible en la pestaña Facturas. Saludos cordiales."],
    mobile: ["Hola, actualice la aplicación a la versión 4.2.1 y reinicie su dispositivo. La corrección del cierre inesperado está incluida. Saludos cordiales."],
    webhooks: ["Hola, se ha corregido un retraso en las entregas. Los eventos en cola se reenviaron automáticamente. Saludos cordiales."],
    account: ["Hola, le hemos enviado un nuevo enlace válido durante 30 minutos. Revise su carpeta de correo no deseado. Saludos cordiales."],
  },
};
const FOLLOWUP = {
  fr: "Le probleme est revenu, ca ne fonctionne toujours pas, c'est encore la meme erreur.",
  en: "The problem is back, it still does not work, it is the same error again.",
  es: "El problema ha vuelto, sigue sin funcionar, es el mismo error otra vez.",
};
const ANGRY = {
  fr: "Toujours pas resolu, c'est inacceptable, ca fait la deuxieme fois que je relance !",
  en: "Still not resolved, this is unacceptable, this is the second time I am following up!",
  es: "Sigue sin resolverse, es inaceptable, es la segunda vez que lo reclamo.",
};
const INTERNAL = {
  fr: ['Cas classique, rien de special.', "Client sympa, resolu rapidement merci a l'equipe.", 'Encore le meme souci, vraiment fatiguant cette semaine.', 'Ca part en vrille, trop de tickets, je suis sur les rotules.'],
  en: ['Classic case, nothing special.', 'Friendly customer, resolved quickly thanks to the team.', 'Same issue again, really tiring this week.', 'It is getting out of hand, too many tickets, I am exhausted.'],
  es: ['Caso clásico, nada especial.', 'Cliente amable, resuelto rápido gracias al equipo.', 'Otra vez el mismo problema, agotador esta semana.', 'Se nos va de las manos, demasiados tickets, estoy agotado.'],
};

const CUSTOMERS = [
  ['Marie Dupont', 'marie@northwind.io', 'Northwind', 'enterprise'], ['Liam Carter', 'liam@globex.com', 'Globex', 'enterprise'],
  ['Sofia Rossi', 'sofia@initech.eu', 'Initech', 'enterprise'], ['Yuki Tanaka', 'yuki@umbrella.jp', 'Umbrella', 'enterprise'],
  ['Hugo Martin', 'hugo@lumen.fr', 'Lumen', 'premium'], ['Emma Wilson', 'emma@brightly.co', 'Brightly', 'premium'],
  ['Noah Garcia', 'noah@sunrise.es', 'Sunrise', 'premium'], ['Lea Bernard', 'lea@atelier.fr', 'Atelier 9', 'standard'],
  ['Omar Haddad', 'omar@souk.ma', 'Souk', 'standard'], ['Ana Silva', 'ana@vento.pt', 'Vento', 'standard'],
  ['Paul Weber', 'paul@kraft.de', 'Kraft', 'standard'], ['Ines Costa', 'ines@marea.pt', 'Marea', 'standard'],
];

const HOT = {
  title: 'We still have the same SSO login problem',
  body: 'For several days we still cannot log in, it is still blocked and nobody answers.',
  escalation: 'This is the third time I am writing to you. This is unacceptable, we are considering cancelling our contract and we will switch to another provider if nothing is done today!',
};

/**
 * Supprime le jeu de demonstration (organisation « acme » et ses comptes @kairos.dev) pour le recreer a neuf.
 * Les horodatages de la demo sont relatifs a l'instant du remplissage : sans reinitialisation, elle « vieillit » et les
 * analyses sensibles au temps (incident naissant, SLA) changent de resultat. Les tests l'appellent donc avant chaque serie.
 * Ne touche JAMAIS une autre organisation.
 */
export async function resetDemo() {
  await pool.query('DELETE FROM orgs WHERE slug=$1', [DEMO.orgSlug]);
  await pool.query(`DELETE FROM users WHERE email LIKE '%@kairos.dev'`);
}

export async function seedDemo(log = console.log) {
  const exists = await pool.query('SELECT 1 FROM orgs WHERE slug=$1', [DEMO.orgSlug]);
  if (exists.rowCount) return { skipped: true };
  log('seed: creation du jeu de donnees de demonstration');
  const r = rng(11);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ago = (h) => new Date(Date.now() - h * 3_600_000);
  const pw = await hashPassword(DEMO.password);

  await tx(async (db) => {
    const org = await db.one(`INSERT INTO orgs(name, slug, settings) VALUES ('Acme Support', $1, '{"portalEnabled":true,"keyPrefix":"ACM"}') RETURNING id`, [DEMO.orgSlug]);
    const people = [
      [DEMO.email, 'Alice Martin', 'owner', ['billing', 'sso'], ['fr', 'en'], 'Europe/Paris'],
      ['bruno@kairos.dev', 'Bruno Leroy', 'agent', ['api', 'checkout', 'webhooks'], ['fr'], 'Europe/Paris'],
      ['chen@kairos.dev', 'Chen Wei', 'agent', ['mobile', 'sso'], ['en', 'es'], 'Asia/Singapore'],
      ['dana@kairos.dev', 'Dana Okafor', 'agent', ['billing', 'account'], ['en', 'fr'], 'Africa/Lagos'],
      ['viewer@kairos.dev', 'Victor Lecture', 'viewer', [], ['fr'], 'Europe/Paris'],
    ];
    const users = [];
    for (const [email, name, role, skills, langs, tz] of people) {
      const u = await db.one('INSERT INTO users(email, password_hash, display_name, email_verified) VALUES ($1,$2,$3,true) RETURNING id', [email, pw, name]);
      await db.query('INSERT INTO memberships(user_id, org_id, role, skills, languages, timezone) VALUES ($1,$2,$3,$4,$5,$6)', [u.id, org.id, role, skills, langs, tz]);
      users.push({ id: u.id, role, skills });
    }
    const agents = users.filter((u) => u.role !== 'viewer');

    const custs = [];
    for (const [name, email, company, tier] of CUSTOMERS) custs.push(await db.one('INSERT INTO customers(org_id, email, name, company, tier) VALUES ($1,$2,$3,$4,$5) RETURNING id, tier', [org.id, email, name, company, tier]));

    const articles = [];
    for (const [title, body] of KB) articles.push(await db.one(`INSERT INTO kb_articles(org_id, title, body, source, last_verified_at, helpful, unhelpful, views, updated_at) VALUES ($1,$2,$3,'confluence', $4, $5, $6, $7, $8) RETURNING id, title`, [org.id, title, body, ago(24 * (title.includes('webhooks') ? 400 : 30)), 8, title.includes('mobile') ? 7 : 1, 40, ago(24 * (title.includes('webhooks') ? 400 : 30))]));
    // Article perime a dessein : ancien, avis negatifs, cite par des tickets rouverts.
    const stale = articles[5];
    // Versions anglaise et espagnole des memes articles (etat neuf : seul l'original francais « webhooks » est perime a dessein).
    for (const rows of [KB_EN, KB_ES]) for (const [title, body] of rows) {
      await db.query(`INSERT INTO kb_articles(org_id, title, body, source, last_verified_at, helpful, unhelpful, views, updated_at) VALUES ($1,$2,$3,'confluence',$4,8,1,40,$4)`, [org.id, title, body, ago(24 * 30)]);
    }

    for (const [prio, frt, res] of [['critical', 30, 240], ['high', 120, 720], ['medium', 480, 2880], ['low', 1440, 7200]]) {
      await db.query('INSERT INTO sla_policies(org_id, name, priority, first_response_mins, resolve_mins) VALUES ($1,$2,$3,$4,$5)', [org.id, `SLA ${prio}`, prio, frt, res]);
    }
    await db.query(`INSERT INTO deploys(org_id, name, version, component, deployed_at) VALUES ($1,'API gateway','v3.8.0','api',$2), ($1,'Checkout service','v2.14.0','checkout',$3), ($1,'Mobile app','v4.2.0','mobile',$4)`, [org.id, ago(24 * 20), ago(7), ago(24 * 9)]);

    await db.query(`INSERT INTO rules(org_id, name, name_i18n, priority, condition, actions) VALUES
      ($1,'Clients enterprise : priorite haute', '{"fr":"Clients enterprise : priorité haute","en":"Enterprise customers: high priority","es":"Clientes enterprise: prioridad alta"}', 10, '{"all":[{"field":"customer.tier","op":"eq","value":"enterprise"},{"field":"priority","op":"in","value":["low","medium"]}]}', '[{"type":"set_priority","value":"high"},{"type":"add_tag","value":"vip"}]'),
      ($1,'Menace de depart : escalade', '{"fr":"Menace de départ : escalade","en":"Churn threat: escalate","es":"Amenaza de baja: escalar"}', 20, '{"field":"text","op":"containsAny","value":["resilier","cancel","changer de fournisseur","switch to"]}', '[{"type":"escalate"},{"type":"notify","value":"ticket.churn_risk"}]'),
      ($1,'Francophone : agent de langue', '{"fr":"Francophone : agent de même langue","en":"French speaker: language-matched agent","es":"Francófono: agente del mismo idioma"}', 30, '{"field":"lang","op":"eq","value":"fr"}', '[{"type":"assign","value":"lang_match"}]')`, [org.id]);

    let seq = 0;
    const insert = async ({ title, body, comp, cust, status, prio, createdH, assignee, reopened = 0, agentReplyMin = null, resolveH = null, kb = null, followUp = null, internal = null, tags = [] }) => {
      seq++;
      const created = ago(createdH);
      const text = `${title}\n${body}`;
      const lang = detectLang(text);
      const t = await db.one(
        `INSERT INTO tickets(org_id, seq, key, customer_id, assignee_id, title, body, status, priority, channel, lang, tags, component, sentiment, frustration, minhash, reopened_count, first_response_at, resolved_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'portal',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING id`,
        [org.id, seq, `ACM-${seq}`, cust.id, assignee?.id ?? null, title, body, status, prio, lang, tags, comp,
          sentiment(text), frustration(text), minhash(text), reopened,
          agentReplyMin != null ? new Date(created.getTime() + agentReplyMin * 60000) : null,
          resolveH != null ? new Date(created.getTime() + resolveH * 3_600_000) : null, created]);
      await db.query(`INSERT INTO ticket_events(ticket_id, type, data, created_at) VALUES ($1,'created','{"channel":"portal"}',$2)`, [t.id, created]);
      let cursor = created.getTime();
      if (agentReplyMin != null && assignee) {
        cursor += agentReplyMin * 60000;
        const reply = pick((REPLIES[lang] ?? REPLIES.en)[comp] ?? (REPLIES[lang] ?? REPLIES.en).account);
        await db.query('INSERT INTO ticket_comments(ticket_id, author_user_id, body, sentiment, created_at) VALUES ($1,$2,$3,$4,$5)', [t.id, assignee.id, reply, sentiment(reply), new Date(cursor)]);
        const note = internal ? pick(INTERNAL[lang] ?? INTERNAL.en) : null;
        if (note) await db.query('INSERT INTO ticket_comments(ticket_id, author_user_id, internal, body, sentiment, created_at) VALUES ($1,$2,true,$3,$4,$5)', [t.id, assignee.id, note, sentiment(note), new Date(cursor + 60000)]);
      }
      if (followUp) {
        const fu = followUp === 'angry' ? (ANGRY[lang] ?? ANGRY.en) : (FOLLOWUP[lang] ?? FOLLOWUP.en);
        cursor += 3_600_000 * (1 + r() * 5);
        await db.query('INSERT INTO ticket_comments(ticket_id, author_is_customer, body, sentiment, created_at) VALUES ($1,true,$2,$3,$4)', [t.id, fu, sentiment(fu), new Date(cursor)]);
      }
      if (resolveH != null) await db.query(`INSERT INTO ticket_events(ticket_id, type, data, created_at) VALUES ($1,'status_changed','{"to":"resolved"}',$2)`, [t.id, new Date(created.getTime() + resolveH * 3_600_000)]);
      if (kb) await db.query(`INSERT INTO ticket_kb_links(ticket_id, article_id, relation, score) VALUES ($1,$2,'used',0.9) ON CONFLICT DO NOTHING`, [t.id, kb.id]);
      return t;
    };

    const byComp = { checkout: 4, sso: 2, api: 1, billing: 3, mobile: 2, webhooks: 1, account: 3 };
    const kbFor = { account: articles[0], api: articles[1], billing: articles[2], webhooks: articles[3], checkout: articles[4], mobile: stale };
    const compNames = Object.keys(T);

    // 1) Historique : ~110 tickets sur 60 jours, majoritairement resolus.
    for (let i = 0; i < 110; i++) {
      const comp = pick(compNames.filter((c) => c !== 'sso')); // SSO volontairement sans documentation
      const [title, body] = pick(T[comp]);
      const cust = pick(custs);
      const createdH = 24 * (1 + Math.floor(r() * 58)) + r() * 20;
      const assignee = agents.find((a) => a.skills.includes(comp)) && r() > 0.25 ? pick(agents.filter((a) => a.skills.includes(comp))) : pick(agents);
      const prio = cust.tier === 'enterprise' ? pick(['high', 'high', 'critical']) : pick(['low', 'medium', 'medium', 'high']);
      const resolveH = (comp === 'mobile' ? 30 + r() * 80 : 2 + r() * 20) * (prio === 'critical' ? 0.5 : 1);
      // Le mobile s'appuie sur l'article perime : plusieurs de ces tickets sont rouverts.
      const reopened = comp === 'mobile' && r() > 0.4 ? 1 : r() > 0.93 ? 1 : 0;
      await insert({ title, body, comp, cust, status: 'resolved', prio, createdH, assignee, reopened, agentReplyMin: 10 + r() * 200, resolveH, kb: r() > 0.35 ? kbFor[comp] : null,
        followUp: reopened ? true : null,
        internal: r() > 0.5 ? true : null });
    }

    // 2) Regression : pic de tickets API 24 h apres le deploiement d'il y a 20 jours.
    for (let i = 0; i < 9; i++) { const [title, body] = pick(T.api); await insert({ title, body, comp: 'api', cust: pick(custs), status: 'resolved', prio: 'high', createdH: 24 * 20 - 2 - i * 1.5, assignee: agents[1], agentReplyMin: 30, resolveH: 6 + r() * 10, kb: articles[1] }); }

    // 3) Lacune documentaire : le SSO/SAML n'a aucun article ; plusieurs tickets non couverts.
    for (let i = 0; i < 7; i++) { const [title, body] = T.sso[i % 3]; await insert({ title, body, comp: 'sso', cust: pick(custs), status: i < 4 ? 'resolved' : 'open', prio: 'high', createdH: 24 * (2 + i * 4) + r() * 6, assignee: agents[2], agentReplyMin: 60 + r() * 120, resolveH: i < 4 ? 8 + r() * 20 : null }); }

    // 4) Incident en cours : pic sur "checkout" apres le deploiement d'il y a 7 h.
    for (let i = 0; i < 14; i++) {
      const [title, body] = T.checkout[i % 4];
      await insert({ title, body, comp: 'checkout', cust: custs[i % 7], status: 'open', prio: custs[i % 7].tier === 'enterprise' ? 'critical' : 'high', createdH: 0.4 + i * 0.35, assignee: i < 3 ? agents[1] : null, agentReplyMin: i < 3 ? 12 : null, tags: ['incident'] });
    }

    // 5) Client au bord du depart : plusieurs tickets tendus, reouverts, avec menace explicite.
    const hot = custs[2];
    for (let i = 0; i < 4; i++) {
      await insert({ title: HOT.title, body: i === 3 ? HOT.escalation : HOT.body, comp: 'sso', cust: hot, status: 'open', prio: 'high', createdH: 24 * (3 - i) + 2, assignee: agents[2], reopened: i > 0 ? 1 : 0, agentReplyMin: i === 3 ? null : 600, followUp: i < 3 ? 'angry' : null });
    }

    // 6) Tickets recents tendus en attente (pour handoff / forecast SLA).
    for (let i = 0; i < 6; i++) {
      const [title, body] = pick([...T.billing, ...T.account, ...T.webhooks]);
      await insert({ title, body, comp: pick(['billing', 'account', 'webhooks']), cust: pick(custs), status: 'open', prio: pick(['medium', 'high']), createdH: 20 + i * 14, assignee: agents[(i % 3) + 1] });
    }
    await db.query('UPDATE orgs SET ticket_seq=$2 WHERE id=$1', [org.id, seq]);
    await db.query(`INSERT INTO webhooks(org_id, url, secret_enc, events) VALUES ($1,'https://hooks.example.com/kairos',$2,'{ticket.created,ticket.reopened,ticket.churn_risk}')`, [org.id, encrypt('whsec_demo_only')]);

    // 7) Messagerie d'equipe : deux salons et un message direct, avec des demandes citees par leur reference.
    const incidentKey = (await db.one(`SELECT key FROM tickets WHERE org_id=$1 AND 'incident' = ANY(tags) ORDER BY seq LIMIT 1`, [org.id])).key;
    const hotKey = (await db.one(`SELECT key FROM tickets WHERE org_id=$1 AND title=$2 ORDER BY seq DESC LIMIT 1`, [org.id, HOT.title])).key;
    const [alice, bruno, chen, dana] = users;
    const channel = async (name, topic, by) => (await db.one(`INSERT INTO chat_channels(org_id, kind, name, topic, topic_i18n, created_by) VALUES ($1,'channel',$2,$3,$4,$5) RETURNING id`, [org.id, name, topic?.fr ?? null, topic ? JSON.stringify(topic) : null, by.id])).id;
    const general = await channel('general', null, alice);
    const incidents = await channel('incidents', { fr: 'Pannes en cours et coordination', en: 'Ongoing outages and coordination', es: 'Incidencias en curso y coordinación' }, alice);
    const dm = (await db.one(`INSERT INTO chat_channels(org_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) RETURNING id`, [org.id, [alice.id, bruno.id].sort().join(':'), alice.id])).id;
    // `text` : chaine, ou { fr, en, es } pour afficher le message dans la langue de l'interface (colonne body_i18n).
    const say = async (ch, who, minutesAgo, text, replyTo = null) => (await db.one('INSERT INTO chat_messages(channel_id, author_id, body, body_i18n, created_at, reply_to) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [ch, who.id, typeof text === 'string' ? text : text.fr, typeof text === 'string' ? null : JSON.stringify(text), new Date(Date.now() - minutesAgo * 60000), replyTo])).id;
    await say(general, alice, 60 * 26, { fr: "Bonjour à tous. Point rapide demain à 9 h : la file critique et les relances de la semaine.", en: "Morning everyone. Quick sync tomorrow at 9 am: the critical queue and this week's follow-ups.", es: "Buenos días a todos. Reunión rápida mañana a las 9 h: la cola crítica y los seguimientos de la semana." });
    await say(general, dana, 60 * 25, { fr: "Je prends les demandes de facturation de la nuit.", en: "I'll take the overnight billing requests.", es: "Me encargo de las solicitudes de facturación de la noche." });
    await say(general, chen, 60 * 9, { fr: `Le client de ${hotKey} a relancé trois fois. Je lui écris avant midi.`, en: `The customer on ${hotKey} has followed up three times. I'll write to them before noon.`, es: `El cliente de ${hotKey} ha insistido tres veces. Le escribo antes del mediodía.` });
    await say(general, alice, 60 * 8, { fr: `Merci Chen. Si la réponse tarde, passe-moi ${hotKey}, je l'appelle.`, en: `Thanks Chen. If the reply is slow, hand ${hotKey} over to me and I'll call them.`, es: `Gracias, Chen. Si la respuesta tarda, pásame ${hotKey} y lo llamo.` });
    const firstIncident = await say(incidents, bruno, 55, { fr: `Pic de demandes sur le paiement depuis le dernier déploiement. Premier cas : ${incidentKey}.`, en: `Spike in payment requests since the last deployment. First case: ${incidentKey}.`, es: `Pico de solicitudes de pago desde el último despliegue. Primer caso: ${incidentKey}.` });
    await say(incidents, dana, 49, { fr: "Même symptôme côté facturation : erreur 502 à la validation de la commande.", en: "Same symptom on the billing side: 502 error when the order is confirmed.", es: "Mismo síntoma en facturación: error 502 al confirmar el pedido." }, firstIncident);
    const lastIncident = await say(incidents, bruno, 40, { fr: "Je regroupe tout sous une seule demande parente et je préviens les clients concernés.", en: "I'm grouping everything under a single parent request and notifying the affected customers.", es: "Lo agrupo todo en una única solicitud principal y aviso a los clientes afectados." });
    await say(dm, alice, 120, { fr: "Bruno, peux-tu vérifier le pare-feu de l'API avant la fin de journée ?", en: "Bruno, can you check the API firewall before the end of the day?", es: "Bruno, ¿puedes revisar el firewall de la API antes de que acabe el día?" });
    await say(dm, bruno, 100, { fr: "Oui, je regarde ça cet après-midi et je te dis.", en: "Yes, I'll look at it this afternoon and let you know.", es: "Sí, lo reviso esta tarde y te cuento." });
    // Leur dernier passage : chacun a lu jusqu'a un point different, ce qui donne de vrais compteurs de messages non lus.
    const lastOf = async (ch) => (await db.one('SELECT max(id) AS id FROM chat_messages WHERE channel_id=$1', [ch])).id;
    for (const [ch, who, readUpTo] of [[general, alice, await lastOf(general)], [general, bruno, await lastOf(general)], [incidents, alice, lastIncident - 2], [incidents, bruno, lastIncident - 2], [dm, alice, 0], [dm, bruno, await lastOf(dm)]]) {
      await db.query('INSERT INTO chat_members(channel_id, user_id, last_read_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ch, who.id, readUpTo]);
    }
  });
  log(`seed: termine. Connexion demo : ${DEMO.email} / ${DEMO.password}`);
  return { skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { migrate } = await import('./migrate.js');
  await migrate();
  await seedDemo();
  await pool.end();
}
