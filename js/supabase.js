import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zplisqwoejxrdrpbfass.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1u8sicdlwn15-I_9kvQmLA_NavAUkDs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const REACTIONS = [
  { key: 'heart', emoji: '❤️', label: 'Love' },
  { key: 'laugh', emoji: '😂', label: 'Haha' },
  { key: 'sad',   emoji: '😢', label: 'Sad'  },
  { key: 'cry',   emoji: '😭', label: 'Cry'  },
  { key: 'angry', emoji: '😡', label: 'Angry'}
];

export function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export function initials(name) {
  return (name || 'G').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}
