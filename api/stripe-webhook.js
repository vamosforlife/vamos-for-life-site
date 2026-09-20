// Webhook Stripe : Stripe appelle cette adresse des qu'un paiement est confirme.
// C'est la source de verite du paiement : elle ne depend pas du navigateur du client.
//
// Variables d'environnement necessaires (Vercel > Settings > Environment Variables) :
//   STRIPE_SECRET_KEY          -> deja configuree
//   STRIPE_WEBHOOK_SECRET      -> donnee par Stripe a la creation du webhook (commence par whsec_)
//   SUPABASE_URL               -> https://uoalorkwkjlsyhpgwynb.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> cle "service_role" de Supabase (secrete, jamais cote navigateur)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Methode non autorisee' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('Webhook : cles Stripe manquantes cote serveur');
    res.status(500).json({ error: 'Configuration serveur incomplete' });
    return;
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Signature invalide : la requete ne vient pas de Stripe.
    console.error('Webhook : signature invalide', err.message);
    res.status(400).json({ error: 'Signature invalide' });
    return;
  }

  // On ne traite que les paiements reussis.
  if (event.type !== 'payment_intent.succeeded') {
    res.status(200).json({ received: true, ignored: event.type });
    return;
  }

  const paymentIntent = event.data.object;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Webhook : configuration Supabase manquante');
    // On repond 200 pour que Stripe ne renvoie pas l'evenement en boucle,
    // l'erreur est visible dans les logs Vercel.
    res.status(200).json({ received: true, warning: 'Supabase non configure' });
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    // La commande a-t-elle deja ete enregistree par le navigateur du client ?
    const { data: existing, error: selectError } = await supabase
      .from('orders')
      .select('id, status')
      .eq('stripe_session_id', paymentIntent.id)
      .limit(1);

    if (selectError) throw selectError;

    if (existing && existing.length > 0) {
      // Oui : on s'assure simplement que le statut est bien "payee".
      if (existing[0].status !== 'payee') {
        const { error: updateError } = await supabase
          .from('orders')
          .update({ status: 'payee' })
          .eq('id', existing[0].id);
        if (updateError) throw updateError;
      }
      res.status(200).json({ received: true, action: 'deja_enregistree' });
      return;
    }

    // Non : le navigateur n'a pas pu enregistrer la commande (fermeture, coupure reseau...).
    // On cree une ligne de secours pour ne pas perdre le paiement.
    const metadata = paymentIntent.metadata || {};
    const { error: insertError } = await supabase.from('orders').insert({
      user_id: metadata.user_id || null,
      items: null,
      shipping_fee: null,
      total: paymentIntent.amount / 100,
      status: 'payee_a_verifier',
      stripe_session_id: paymentIntent.id,
      buyer_email: paymentIntent.receipt_email || null,
      is_gift: false,
    });

    if (insertError) throw insertError;

    res.status(200).json({ received: true, action: 'commande_de_secours_creee' });
  } catch (err) {
    console.error('Webhook : erreur Supabase', err.message || err);
    // 500 => Stripe reessaiera automatiquement l'envoi de l'evenement.
    res.status(500).json({ error: 'Erreur enregistrement commande' });
  }
}

// Stripe exige le corps brut de la requete pour verifier la signature.
// Cette propriete doit rester attachee a la fonction exportee elle-meme
// (et non a module.exports avant la reassignation), sinon Vercel ne la
// voit jamais et parse le corps en JSON avant qu'on puisse le lire brut.
handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;
