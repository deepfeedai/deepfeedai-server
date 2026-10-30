'use strict';
const {imageError} = require('./image-errors');
async function assertImageAllowed(tenantId, operation) {
  const {isFeatureEnabled} = require('./feature-registry');
  const {checkPlanLimit} = require('./plan-limits');
  if (!await isFeatureEnabled(tenantId,'image_generation')) throw imageError('IMAGE_FEATURE');
  if (!(await checkPlanLimit(tenantId,'storage')).allowed) throw imageError('IMAGE_STORAGE');
  // Validate before the optional paid concept request.
  await require('./ai-router').validateImageConfig(operation,tenantId);
}
async function canGenerateForUser(email, tenantId) {
  const row=await require('../db').prepare('SELECT u.role,r.permissions FROM users u LEFT JOIN roles r ON r.name=u.role AND r.tenant_id=u.tenant_id WHERE LOWER(u.email)=LOWER($1) AND u.tenant_id=$2 AND u.is_active=1').get(email,tenantId);
  if(!row) return false;
  let permissions=row.permissions;
  if(typeof permissions==='string') {try{permissions=JSON.parse(permissions);}catch{return false;}}
  if(!Array.isArray(permissions)) permissions=row.role==='owner'?['*']:[];
  return permissions.some(p=>['*','media.*','media.create'].includes(p));
}
module.exports = {assertImageAllowed,canGenerateForUser};
