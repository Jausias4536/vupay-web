/*
 * Connecteurs externes de VuPay : envoi des SMS et paiement des retraits Mobile Money.
 * Choisis-les dans les variables du Worker (SMS_PROVIDER et PAYOUT_PROVIDER).
 *
 * Les modes "http" sont des modèles génériques : chaque fournisseur (CinetPay, PayDunya,
 * Wave Business, Orange SMS API, etc.) a son propre format. Adapte buildSmsRequest()
 * et buildPayoutRequest() en suivant la documentation de ton fournisseur.
 */

// ---------- SMS ----------
function buildSmsRequest(env, to, message) {
  return {
    url: env.SMS_API_URL,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (env.SMS_API_KEY || '') },
    body: { to, message, sender: env.SMS_SENDER || 'VuPay' }
  };
}

export async function sendSms(env, to, message) {
  const mode = env.SMS_PROVIDER || 'console';
  if (mode === 'console') {
    // Visible dans Cloudflare : Workers & Pages > vupay > Logs
    console.log(`[SMS -> ${to}] ${message}`);
    return;
  }
  if (mode === 'http') {
    const r = buildSmsRequest(env, to, message);
    if (!r.url) throw new Error('SMS_API_URL manquant');
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
    if (!res.ok) throw new Error('Envoi SMS refusé (' + res.status + ')');
    return;
  }
  throw new Error('SMS_PROVIDER inconnu : ' + mode);
}

// ---------- Retraits Mobile Money ----------
/*
 * Modes (variable PAYOUT_PROVIDER) :
 *   simulation : passe tout seul à "Envoyé" après quelques secondes (AUCUN argent envoyé)
 *   manual     : reste "En attente" ; tu paies toi-même puis tu valides dans /admin.html
 *   http       : appelle l'API de ton agrégateur ; le statut final arrive par le webhook
 *                POST /api/webhooks/payout  { reference, status: "success" | "failed" }
 *                avec l'en-tête  X-Webhook-Secret: <PAYOUT_WEBHOOK_SECRET>
 *
 * Retourne le statut à enregistrer tout de suite : 'En attente' ou 'En traitement'.
 */
function buildPayoutRequest(env, tx) {
  return {
    url: env.PAYOUT_API_URL,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (env.PAYOUT_API_KEY || '') },
    body: {
      reference: tx.ref,
      amount: tx.amount,
      currency: tx.currency,
      operator: tx.operator,
      phone: tx.phone,
      notify_url: (env.PUBLIC_URL || '') + '/api/webhooks/payout'
    }
  };
}

export async function payout(env, tx) {
  const mode = env.PAYOUT_PROVIDER || 'simulation';
  if (mode === 'simulation' || mode === 'manual') return 'En attente';
  if (mode === 'http') {
    const r = buildPayoutRequest(env, tx);
    if (!r.url) throw new Error('PAYOUT_API_URL manquant');
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
    if (!res.ok) throw new Error('Retrait refusé par le fournisseur (' + res.status + ')');
    return 'En traitement';
  }
  throw new Error('PAYOUT_PROVIDER inconnu : ' + mode);
}
