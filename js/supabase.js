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

// ── Appwrite (read-only for video metadata) ──
export const APPWRITE = {
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: '66b8be7400121b5d4697',
  databaseId: '66b32b3600246bc34956',
  videosCollection: '6915577000216471ecf7',
  usersCollection: '66b32b4a0022880bc87e'
};

export async function appwriteList(collectionId, queries = []) {
  let url = `${APPWRITE.endpoint}/databases/${APPWRITE.databaseId}/collections/${collectionId}/documents`;
  if (queries.length) {
    const params = queries.map(q => `queries[]=${encodeURIComponent(q)}`).join('&');
    url += '?' + params;
  }
  const res = await fetch(url, {
    headers: { 'X-Appwrite-Project': APPWRITE.projectId, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(`Appwrite error: ${errorData.message || res.status}`);
  }
  return res.json();
}

export async function appwriteGet(collectionId, documentId) {
  const url = `${APPWRITE.endpoint}/databases/${APPWRITE.databaseId}/collections/${collectionId}/documents/${documentId}`;
  const res = await fetch(url, {
    headers: { 'X-Appwrite-Project': APPWRITE.projectId, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Appwrite error: ${res.status}`);
  return res.json();
}

// ── Bunny Stream Config ──
const BUNNY = {
  cdnHostname: 'vz-fdf88b4d-33a.b-cdn.net',
};

// ── Edge Function helper ──
async function callEdgeFunction(functionName, payload = {}) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('Not logged in');
  
  const url = `${SUPABASE.url}/functions/v1/${functionName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Request failed');
  }
  
  return await response.json();
}
