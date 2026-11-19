// Page « hors ligne » : texte dans la langue choisie dans Kairos (sinon celle du navigateur). Fichier externe : la CSP interdit les scripts en ligne.
var TXT = {
  fr: ['Vous êtes hors ligne', 'Kairos a besoin d’une connexion pour afficher vos tickets et vos messages. Vérifiez votre réseau, puis réessayez.', 'Réessayer'],
  en: ['You are offline', 'Kairos needs a connection to show your tickets and messages. Check your network, then try again.', 'Try again'],
  es: ['Estás sin conexión', 'Kairos necesita conexión para mostrar tus tickets y mensajes. Revisa tu red y vuelve a intentarlo.', 'Reintentar'],
};
var lang = 'en';
try { var s = localStorage.getItem('kairos.lang'); if (TXT[s]) lang = s; else { var n = (navigator.language || '').slice(0, 2); if (TXT[n]) lang = n; } } catch (e) { /* stockage indisponible */ }
document.documentElement.lang = lang;
document.getElementById('t').textContent = TXT[lang][0];
document.getElementById('d').textContent = TXT[lang][1];
var b = document.getElementById('b'); b.textContent = TXT[lang][2];
b.addEventListener('click', function () { location.reload(); });
window.addEventListener('online', function () { location.reload(); });
