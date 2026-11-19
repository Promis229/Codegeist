import analyticsRoutes from './analytics.js';
import chatRoutes from './chat.js';
import coreRoutes from './core.js';
import forgeRoutes from './forge.js';
import intelligenceRoutes from './intelligence.js';
import intelligence2Routes from './intelligence2.js';
import intelligence3Routes from './intelligence3.js';
import mlRoutes from './ml.js';
import profileRoutes from './profile.js';
import publicRoutes from './public.js';
import rulesRoutes from './rules.js';
import ticketRoutes from './tickets.js';
import webhookRoutes from './webhooks.js';

export async function domainRoutes(api) {
  await api.register(coreRoutes);
  await api.register(ticketRoutes);
  await api.register(chatRoutes);
  await api.register(profileRoutes);
  await api.register(rulesRoutes);
  await api.register(webhookRoutes);
  await api.register(analyticsRoutes);
  await api.register(intelligenceRoutes);
  await api.register(intelligence2Routes);
  await api.register(intelligence3Routes);
  await api.register(mlRoutes);
  await api.register(forgeRoutes);
  await api.register(publicRoutes);
}
