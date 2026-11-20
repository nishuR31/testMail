import { config } from '../config.js';
import { emailjs } from './emailjs.js';
import { resend } from './resend.js';
import { simfast, simslow } from './simulator.js';

const ALL = [emailjs, resend, simfast, simslow];

export const enabledProviders = () => ALL.filter((p) => p.kind !== 'sim' || config.simulatorEnabled);
export const readyProviders = () => enabledProviders().filter((p) => p.missing().length === 0);
export const providerById = (id) => enabledProviders().find((p) => p.id === id);
