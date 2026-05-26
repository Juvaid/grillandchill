import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const VAPID_PUBLIC_KEY = 'BLd5176BENuYPrDrfx3388HbyX-BwJ2Ln8jaa4KtWEvhrzC-icfjzk5CxxSL6m_rgsW9qDA_Zv_m1EFLhAcrfnI';
const VAPID_PRIVATE_KEY = 'sDgFyYuNh5m3WIvhYXUMkDsS8j_40vYR31UQIu6Bwec';

webpush.setVapidDetails(
  'mailto:admin@grillandchillpizzeria.juvaid.in',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  // Allow POST requests only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    console.log('Received push webhook payload:', payload);

    const record = payload.record;
    if (!record) {
      return res.status(400).json({ error: 'Missing record payload' });
    }

    const customerName = record.customer_name || 'Customer';
    const totalAmount = record.total_amount || 0;
    const orderId = record.id || '';

    // Initialize Supabase Client with service key
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch all push subscriptions
    const { data: subs, error: subErr } = await supabase
      .from('admin_push_subscriptions')
      .select('subscription');

    if (subErr) {
      console.error('Error fetching subscriptions:', subErr);
      return res.status(500).json({ error: 'Database error fetching subscriptions' });
    }

    if (!subs || subs.length === 0) {
      console.log('No active admin push subscriptions found');
      return res.status(200).json({ status: 'No subscriptions' });
    }

    console.log(`Sending push notification to ${subs.length} admin subscription(s)...`);

    const notificationPayload = JSON.stringify({
      title: 'New Order Received! 🍕',
      body: `${customerName} ordered for ₹${totalAmount} (#${orderId})`
    });

    const sendPromises = subs.map(item => {
      return webpush.sendNotification(item.subscription, notificationPayload)
        .then(() => {
          console.log('Push notification sent successfully');
        })
        .catch(async (err) => {
          console.error('Error sending push notification to endpoint:', item.subscription.endpoint, err);
          // If subscription has expired (410) or is not found (404), delete it from the DB
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log('Removing expired push subscription from database...');
            // Delete from database matching endpoint inside JSON
            const { error: delErr } = await supabase
              .from('admin_push_subscriptions')
              .delete()
              .eq('subscription->endpoint', item.subscription.endpoint);
            if (delErr) {
              console.error('Failed to delete expired subscription:', delErr);
            }
          }
        });
    });

    await Promise.all(sendPromises);

    return res.status(200).json({ success: true, count: subs.length });

  } catch (err) {
    console.error('Push notifier server error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
