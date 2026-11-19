import { Component } from 'react';
import { tr } from '../i18n/index.jsx';
import { isChunkError, reloadOnce } from '../lib/lazy.js';

/**
 * Filet de sécurité : une erreur dans une page n'efface plus toute l'application.
 *  - fichier de page périmé après un déploiement : rechargement automatique (une fois) ;
 *  - autre erreur : message clair avec « Réessayer » ; il disparaît tout seul quand on change de page (resetKey).
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) {
    if (isChunkError(error)) reloadOnce();
    else console.error('[kairos] erreur d’affichage', error); // eslint-disable-line no-console
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkError(error);
    return (
      <div role="alert" className="mx-auto my-16 max-w-md rounded-3xl border border-line bg-surface p-8 text-center">
        <h1 className="font-serif text-[26px] tracking-tight">{tr(stale ? 'err.boundary.updated' : 'err.boundary.title')}</h1>
        <p className="mt-2 text-[14px] text-muted">{tr(stale ? 'err.boundary.updatedText' : 'err.boundary.text')}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {!stale && <button type="button" className="btn" onClick={() => this.setState({ error: null })}>{tr('err.boundary.retry')}</button>}
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{tr('err.boundary.reload')}</button>
        </div>
      </div>
    );
  }
}
