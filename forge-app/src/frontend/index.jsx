import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Box, Button, Heading, Inline, Lozenge, SectionMessage, Spinner, Stack, Text, useProductContext } from '@forge/react';
import { invokeRemote, requestJira } from '@forge/bridge';

const adfToText = (n) => (!n ? '' : typeof n === 'string' ? n : n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(adfToText).join(n.type === 'doc' ? '\n' : ''));

const tone = (v) => (v >= 0.66 ? 'removed' : v >= 0.35 ? 'inprogress' : 'success');
const pct = (v) => `${Math.round((v ?? 0) * 100)} %`;

function Panel() {
  const ctx = useProductContext();
  const issueKey = ctx?.extension?.issue?.key;
  const [state, setState] = useState({ loading: true });

  async function analyse() {
    setState({ loading: true });
    try {
      const r = await requestJira(`/rest/api/3/issue/${issueKey}?fields=summary,description`);
      const issue = await r.json();
      // Le jeton d'invocation Forge (FIT) authentifie l'appel : le backend verifie sa signature via JWKS.
      const res = await invokeRemote({
        path: '/api/v1/forge/triage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { summary: issue.fields.summary, description: adfToText(issue.fields.description).slice(0, 20000) },
      });
      if (res.status >= 400) throw new Error(res.body?.message ?? `Erreur ${res.status}`);
      setState({ loading: false, data: res.body });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  }

  useEffect(() => { if (issueKey) analyse(); }, [issueKey]);

  if (state.loading) return <Spinner label="Analyse en cours" />;
  if (state.error) return <SectionMessage appearance="error" title="Kairos indisponible"><Text>{state.error}</Text></SectionMessage>;
  const d = state.data;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={tone(d.frustration)}>Frustration {pct(d.frustration)}</Lozenge>
        <Lozenge appearance="default">Priorite suggeree : {d.suggestedPriority}</Lozenge>
        {d.rulesFired?.length ? <Lozenge appearance="new">{d.rulesFired.length} regle(s)</Lozenge> : null}
      </Inline>

      {d.possibleDuplicates?.length > 0 && (
        <SectionMessage appearance="warning" title="Doublon probable">
          {d.possibleDuplicates.map((x) => <Text key={x.key}>{x.key} : {x.title} ({pct(x.score)})</Text>)}
        </SectionMessage>
      )}

      <Box>
        <Heading size="small">Connaissance pertinente</Heading>
        {d.knowledge?.length ? d.knowledge.map((k) => (
          <Text key={k.id}>{k.title} ({pct(k.relevance)})</Text>
        )) : <Text>Aucun article ne couvre ce sujet : lacune documentaire probable.</Text>}
      </Box>

      <Button onClick={analyse}>Reanalyser</Button>
    </Stack>
  );
}

ForgeReconciler.render(<React.StrictMode><Panel /></React.StrictMode>);
