// Fonction serveur Vercel : cree une intention de paiement Stripe.
// La cle secrete Stripe (STRIPE_SECRET_KEY) doit etre configuree dans
// Vercel > Settings > Environment Variables. Elle n'est jamais exposee au navigateur.

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Methode non autorisee' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: 'Cle Stripe manquante cote serveur (STRIPE_SECRET_KEY)' });
    return;
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { amount, orderNum, userId } = req.body || {};

    const amountNumber = Number(amount);
    if (!amountNumber || isNaN(amountNumber) || amountNumber <= 0) {
      res.status(400).json({ error: 'Montant invalide' });
      return;
    }

    // Metadonnees : permettent au webhook de retrouver la commande
    // meme si le navigateur du client se ferme avant l'enregistrement.
    const metadata = {};
    if (orderNum) metadata.order_num = String(orderNum).slice(0, 100);
    if (userId) metadata.user_id = String(userId).slice(0, 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amountNumber * 100), // euros -> centimes
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata,
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur Stripe' });
  }
};
