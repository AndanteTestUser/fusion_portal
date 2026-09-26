const DB_NAME = 'fusion_portal_setting_draft';
const STORE = 'drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function loadSettingDraft() { return transact('readonly', (store) => store.get('current')); }
export function saveSettingDraft(value) { return transact('readwrite', (store) => store.put(value, 'current')); }
export function clearSettingDraft() { return transact('readwrite', (store) => store.delete('current')); }
