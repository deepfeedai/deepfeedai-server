'use strict';
const db = require('../db');
const storage = require('./storage');
const {imageError,decodePng} = require('./image-errors');
const {randomUUID} = require('crypto');
// Unique files + compare-and-swap prevent concurrent generations overwriting a
// newer selection. A database failure keeps the old reference and old asset.
async function replaceImage({table,id,tenantId,oldUrl,b64}) {
  if (!['articles','writers'].includes(table)) throw imageError('IMAGE_FAILED');
  const column = table === 'articles' ? 'image_url' : 'avatar_url';
  const folder = table === 'articles' ? 'images' : 'avatars';
  const key = `${folder}/${randomUUID()}.png`;
  let url;
  try { url = await storage.upload(decodePng(b64),'image/png',key,tenantId); }
  catch(e) { throw imageError(e.code === 'IMAGE_INVALID' ? e.code : 'IMAGE_FAILED'); }
  try {
    const row = await db.prepare(`UPDATE ${table} SET ${column}=$1 WHERE id=$2 AND tenant_id=$3 AND ${column} IS NOT DISTINCT FROM $4 RETURNING id`).get(url,id,tenantId,oldUrl ?? null);
    if (!row) throw imageError('IMAGE_CONFLICT');
  } catch(e) {
    // An interrupted DB response can have an uncertain commit outcome. Keep the
    // new asset unless the CAS explicitly reported no update; an orphan is safer
    // than deleting an asset which the database may now reference.
    if(e.code === 'IMAGE_CONFLICT') await storage.remove(key,tenantId).catch(()=>{});
    throw imageError(e.code === 'IMAGE_CONFLICT' ? e.code : 'IMAGE_FAILED');
  }
  // Only delete tenant-local assets owned by this storage abstraction.
  const prefix = `/media/tenants/${tenantId}/${folder}/`;
  if (oldUrl?.startsWith(prefix)) await storage.remove(`${folder}/${oldUrl.slice(prefix.length)}`,tenantId).catch(()=>{});
  return url;
}
module.exports = {replaceImage};
